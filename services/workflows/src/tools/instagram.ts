import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, fetchWithTimeout, withOrgScopedClient } from './shared.js';

const ACTIONS = ['list_messages', 'send_dm'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('read')) return 'read';
  return 'send';
}

/** Instagram-scoped user ids (IGSID) are numeric; anything else never reaches a Graph URL. */
export function igRecipientId(v: unknown): string | null {
  const id = String(v ?? '').trim();
  return /^\d{5,25}$/.test(id) ? id : null;
}

function result(action: string, status: 'executed' | 'error', message: string, data: unknown, timestamp: string) {
  return { tool: 'instagram', action, status, message, data, timestamp };
}

function metaString(meta: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Recent Instagram DMs as stored by the inbound webhook (messages.channel_key =
 * 'instagram'): role "user" is the contact, "assistant" is us. RLS-scoped.
 */
async function listMessages(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(payload.limit ?? payload.count)) || 20));
  const raw = payload.contact_id ?? payload.contactId ?? payload.recipient_id;
  const contact = raw ? igRecipientId(raw) : null;
  if (raw && !contact) {
    return result('list_messages', 'error', 'That Instagram contact id is not valid (expected the numeric IGSID).', null, timestamp);
  }
  const rows = await withOrgScopedClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT m.id, m.role, m.content, m.created_at, c.id AS conversation_id, c.contact_id,
              c.metadata->>'sender_name' AS sender_name
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
        WHERE m.org_id = $1
          AND m.channel_key = 'instagram'
          AND ($2::text IS NULL OR c.contact_id = $2)
        ORDER BY m.created_at DESC
        LIMIT $3`,
      [orgId, contact, limit],
    );
    return res.rows;
  });
  const messages = rows.map((r: any) => ({
    id: r.id,
    from: r.role === 'user' ? r.sender_name || r.contact_id : 'us',
    contactId: r.contact_id,
    direction: r.role === 'user' ? 'inbound' : 'outbound',
    text: r.content,
    at: r.created_at,
    conversationId: r.conversation_id,
  }));
  return result(
    'list_messages',
    'executed',
    messages.length ? `Found ${messages.length} Instagram messages` : 'No Instagram messages found',
    { messages, count: messages.length },
    timestamp,
  );
}

/** Reply to an Instagram DM. Meta only allows this within 24 h of the contact's last message. */
async function sendDm(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const text = String(payload.message ?? payload.text ?? payload.body ?? '').trim();
  const recipient = igRecipientId(payload.contact_id ?? payload.contactId ?? payload.recipient_id ?? payload.to);
  if (!text) return result('send_dm', 'error', 'Message text is required.', null, timestamp);
  if (!recipient) {
    return result('send_dm', 'error', 'Instagram contact id (numeric IGSID) is required. Use instagram_list_messages to find it.', null, timestamp);
  }

  const { meta, recent } = await withOrgScopedClient(orgId, async (client) => {
    const chan = await client.query(
      `SELECT meta FROM channels
        WHERE org_id = $1 AND channel_type = 'instagram' AND status IN ('connected', 'active')
        ORDER BY connected_at DESC NULLS LAST
        LIMIT 1`,
      [orgId],
    );
    const win = await client.query(
      `SELECT 1 FROM messages m
         JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
        WHERE m.org_id = $1 AND c.contact_id = $2 AND m.channel_key = 'instagram'
          AND m.role IN ('user', 'customer')
          AND m.created_at > NOW() - INTERVAL '24 hours'
        LIMIT 1`,
      [orgId, recipient],
    );
    return { meta: (chan.rows[0]?.meta || {}) as Record<string, unknown>, recent: win.rows.length > 0 };
  });

  const accessToken =
    metaString(meta, 'meta_access_token', 'accessToken', 'page_access_token') || process.env.META_ACCESS_TOKEN || '';
  const pageId = metaString(meta, 'ig_user_id', 'instagram_account_id', 'page_id', 'pageId');
  if (!accessToken || !pageId) {
    return result('send_dm', 'error', 'Instagram is not connected (missing page access token or account id). Connect it at /connectors.', null, timestamp);
  }
  if (!recent) {
    return result('send_dm', 'error', 'Outside the 24-hour reply window: this contact has not messaged in the last 24 hours, so Instagram will not accept a reply.', { recipientId: recipient }, timestamp);
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(`https://graph.facebook.com/v18.0/${encodeURIComponent(pageId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipient }, message: { text } }),
    });
  } catch (err: unknown) {
    return result('send_dm', 'error', `Network error sending Instagram DM: ${err instanceof Error ? err.message : String(err)}`, { recipientId: recipient }, timestamp);
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    return result('send_dm', 'error', `Instagram API returned ${res.status}: ${body.slice(0, 200)}`, { recipientId: recipient }, timestamp);
  }
  let messageId: string | null = null;
  try {
    messageId = JSON.parse(body)?.message_id ?? null;
  } catch {
    // Graph answered 2xx with a non-JSON body; the send still happened.
  }
  return result('send_dm', 'executed', `Instagram reply sent to ${recipient}`, { recipientId: recipient, messageId, content: text }, timestamp);
}

async function execute(ctx: ToolActionContext) {
  if (ctx.actionName === 'list_messages') return listMessages(ctx);
  return sendDm(ctx);
}

export const instagram: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
