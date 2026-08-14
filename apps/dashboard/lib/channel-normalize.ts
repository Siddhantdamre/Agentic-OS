/**
 * Unified inbound channel_key + persist helper (WS-18 / H2–H5).
 * Org is resolved from channel config, never body org_id.
 */
import type { PoolClient } from 'pg';
import { pool, getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import {
  employeePersonaText,
  parseToolAllowlist,
  type InboundAgentJob,
} from '@/lib/inbound-agent';
import { replyTargetFromChannelMeta } from '@/lib/channel-outbound';

export const CHANNEL_KEYS = [
  'whatsapp',
  'chatwoot',
  'gmail',
  'instagram',
  'sms',
  'owner_whatsapp',
  'widget',
  'inbox',
  'ask_ai',
  'unknown',
] as const;

export type ChannelKey = (typeof CHANNEL_KEYS)[number];

type ChannelRow = { id: string; org_id: string; meta: Record<string, unknown> };

export function normalizeChannelKey(raw: string | null | undefined): ChannelKey {
  const n = (raw || '').toLowerCase().replace(/^channel::/i, '').trim();
  switch (n) {
    case 'whatsapp':
    case 'wa':
      return 'whatsapp';
    case 'chatwoot':
      return 'chatwoot';
    case 'gmail':
    case 'email':
    case 'mail':
      return 'gmail';
    case 'instagram':
    case 'ig':
      return 'instagram';
    case 'sms':
    case 'twilio':
    case 'exotel':
      return 'sms';
    case 'owner_whatsapp':
    case 'owner-whatsapp':
      return 'owner_whatsapp';
    case 'widget':
    case 'embed':
      return 'widget';
    case 'inbox':
    case 'dashboard':
      return 'inbox';
    case 'ask_ai':
    case 'ask-ai':
      return 'ask_ai';
    case '':
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

export type OwnerCommand =
  | { kind: 'brief' }
  | { kind: 'approve_plan'; planId: string }
  | { kind: 'pause_employee'; name: string }
  | { kind: 'unknown' };

const UUID_RE =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i;

export function parseOwnerCommand(text: string): OwnerCommand {
  const trimmed = (text || '').trim();
  if (/^\s*(brief(\s+me)?|briefing)\s*[.!]?\s*$/i.test(trimmed)) {
    return { kind: 'brief' };
  }
  const approve = trimmed.match(/^\s*approve(?:\s+plan)?\s+(.+)$/i);
  if (approve) {
    const idMatch = approve[1].match(UUID_RE);
    if (idMatch) return { kind: 'approve_plan', planId: idMatch[1].toLowerCase() };
    return { kind: 'unknown' };
  }
  const pause = trimmed.match(/^\s*pause\s+(.+)$/i);
  if (pause) {
    const name = pause[1].replace(/[.!]+$/, '').trim();
    if (name) return { kind: 'pause_employee', name };
  }
  return { kind: 'unknown' };
}

export function isOwnerCommand(text: string): boolean {
  const parsed = parseOwnerCommand(text);
  switch (parsed.kind) {
    case 'brief':
    case 'approve_plan':
    case 'pause_employee':
      return true;
    case 'unknown':
      return false;
    default: {
      const _never: never = parsed;
      return _never;
    }
  }
}

export async function resolveChannelByMeta(
  channelType: string,
  metaKey: string,
  metaValue: string | null | undefined
): Promise<ChannelRow | null> {
  if (!metaValue) return null;
  try {
    const res = await pool.query(
      `SELECT id, org_id, meta FROM resolve_channel_by_meta($1, $2, $3)`,
      [channelType, metaKey, metaValue]
    );
    return (res.rows[0] as ChannelRow) ?? null;
  } catch {
    const res = await pool.query(
      `SELECT id, org_id, meta FROM channels
        WHERE channel_type = $1 AND meta->>$2 = $3
        ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
      [channelType, metaKey, metaValue]
    );
    return (res.rows[0] as ChannelRow) ?? null;
  }
}

export async function resolveSingleOrgChannel(channelType: string): Promise<ChannelRow | null> {
  try {
    const orgCount = await pool.query(`SELECT COUNT(*) as count FROM orgs WHERE status = 'active'`);
    if (parseInt(orgCount.rows[0].count, 10) !== 1) return null;
    const res = await pool.query(
      `SELECT id, org_id, meta FROM channels
        WHERE channel_type = $1 AND status IN ('active', 'connected')
        ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
      [channelType]
    );
    return (res.rows[0] as ChannelRow) ?? null;
  } catch {
    return null;
  }
}

export async function resolveOrgByChatwootInbox(
  accountId: string | number | null,
  inboxId: number | null
): Promise<string | null> {
  if (inboxId == null) return null;
  const account = accountId == null ? '' : String(accountId);
  try {
    const res = await pool.query(`SELECT resolve_org_by_chatwoot_inbox($1, $2) AS id`, [
      account,
      inboxId,
    ]);
    return (res.rows[0]?.id as string) || null;
  } catch {
    const res = await pool.query(
      `SELECT org_id FROM chatwoot_inbox_map
        WHERE chatwoot_inbox_id = $1
          AND ($2 = '' OR chatwoot_account_id = $2 OR chatwoot_account_id = '')
        ORDER BY CASE WHEN chatwoot_account_id = $2 THEN 0 ELSE 1 END
        LIMIT 1`,
      [inboxId, account]
    );
    if (res.rows[0]?.org_id) return res.rows[0].org_id as string;
    const chan = await pool.query(
      `SELECT org_id FROM channels WHERE chatwoot_inbox_id = $1 LIMIT 1`,
      [inboxId]
    );
    return (chan.rows[0]?.org_id as string) || null;
  }
}

export async function upsertChatwootInboxMap(
  client: PoolClient,
  orgId: string,
  accountId: string | number | null,
  inboxId: number | null
): Promise<void> {
  if (inboxId == null) return;
  await client.query(
    `INSERT INTO chatwoot_inbox_map (org_id, chatwoot_account_id, chatwoot_inbox_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (chatwoot_account_id, chatwoot_inbox_id)
     DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = NOW()`,
    [orgId, accountId == null ? '' : String(accountId), inboxId]
  );
}

export type PersistInboundInput = {
  orgId: string;
  channelKey: ChannelKey;
  channelType: string;
  contactId: string;
  content: string;
  providerMessageId?: string | null;
  senderName?: string;
  extraMeta?: Record<string, unknown>;
  skipAgent?: boolean;
};

export type PersistInboundResult = {
  conversationId: string;
  messageId: string | null;
  channelId: string;
  inserted: boolean;
  shouldFireAgent: boolean;
  employee: { id?: string; name?: string; role?: string; persona?: unknown; tool_allowlist?: unknown } | undefined;
  connectedChannels: string[];
  chanMeta: Record<string, unknown>;
};

export async function persistInboundMessage(input: PersistInboundInput): Promise<PersistInboundResult> {
  const { client } = await getOrgScopedClient(input.orgId);
  try {
    return await persistInboundMessageWithClient(client, input);
  } finally {
    client.release();
  }
}

export async function persistInboundMessageWithClient(
  client: PoolClient,
  input: PersistInboundInput
): Promise<PersistInboundResult> {
  const orgId = input.orgId;
  const channelType = input.channelType;
  const extraMeta = input.extraMeta || {};

  const channelRes = await client.query(
    `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
     VALUES ($1, $2, 'active', $3::jsonb, NOW())
     ON CONFLICT (org_id, channel_type)
     DO UPDATE SET status = 'active', updated_at = NOW()
     RETURNING id, meta`,
    [orgId, channelType, JSON.stringify({ name: `${channelType} Channel`, ...extraMeta })]
  );
  const channelId = channelRes.rows[0].id as string;
  const chanMeta = (channelRes.rows[0].meta || {}) as Record<string, unknown>;

  const empRes = await client.query(
    `SELECT id, name, role, persona, tool_allowlist FROM ai_employees
     WHERE org_id = $1 AND status = 'active' LIMIT 1`,
    [orgId]
  );
  const employee = empRes.rows[0] as PersistInboundResult['employee'];

  const connectedRes = await client.query(
    `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
    [orgId]
  );
  const connectedChannels = connectedRes.rows.map((row: { channel_type: string }) => row.channel_type);

  let conversationId: string;
  const existingConv = await client.query(
    `SELECT id FROM conversations WHERE org_id = $1 AND contact_id = $2 AND status != 'resolved' LIMIT 1`,
    [orgId, input.contactId]
  );
  const metadata = {
    sender_name: input.senderName || input.contactId,
    channel: input.channelKey,
    ...extraMeta,
  };
  if (existingConv.rows.length > 0) {
    conversationId = existingConv.rows[0].id;
    await client.query(
      `UPDATE conversations SET updated_at = NOW(), summary = $1, metadata = metadata || $2::jsonb
       WHERE id = $3 AND org_id = $4`,
      [input.content.slice(0, 100), JSON.stringify(metadata), conversationId, orgId]
    );
  } else {
    const newConv = await client.query(
      `INSERT INTO conversations (org_id, channel_id, contact_id, employee_id, status, summary, metadata, started_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6, NOW(), NOW())
       RETURNING id`,
      [
        orgId,
        channelId,
        input.contactId,
        employee?.id ?? null,
        input.content.slice(0, 100),
        JSON.stringify(metadata),
      ]
    );
    conversationId = newConv.rows[0].id;
  }

  let inserted = true;
  let messageId: string | null = null;
  if (input.providerMessageId) {
    const dup = await client.query(
      `SELECT id FROM messages WHERE org_id = $1 AND chatwoot_msg_id = $2 LIMIT 1`,
      [orgId, input.providerMessageId]
    );
    if (dup.rows.length > 0) {
      inserted = false;
      messageId = dup.rows[0].id;
    }
  }
  if (inserted) {
    try {
      const msgRes = await client.query(
        `INSERT INTO messages (org_id, conversation_id, role, content, chatwoot_msg_id, channel_key, created_at)
         VALUES ($1, $2, 'user', $3, $4, $5, NOW())
         RETURNING id`,
        [orgId, conversationId, input.content, input.providerMessageId || null, input.channelKey]
      );
      messageId = msgRes.rows[0].id;
    } catch (insertErr: unknown) {
      const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
      if (msg.includes('idx_messages_org_chatwoot_msg_id') || msg.includes('unique')) {
        inserted = false;
      } else {
        throw insertErr;
      }
    }
  }

  if (inserted) {
    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, 'inbound_message', 'success', 200, $3, $4)`,
      [
        orgId,
        channelType,
        `Inbound ${input.channelKey} from ${input.contactId}`,
        JSON.stringify({
          conversationId,
          messageId,
          content: input.content.slice(0, 300),
          channel_key: input.channelKey,
        }),
      ]
    );
    realtimeHub.publish(orgId, {
      type: 'needs_attention',
      conversationId,
      message: input.content.slice(0, 200),
      contactId: input.contactId,
      channelType,
    });
  }

  return {
    conversationId,
    messageId,
    channelId,
    inserted,
    shouldFireAgent: inserted && !input.skipAgent,
    employee,
    connectedChannels,
    chanMeta,
  };
}

export function inboundJobFromPersist(
  orgId: string,
  input: PersistInboundInput,
  persisted: PersistInboundResult
): InboundAgentJob {
  return {
    orgId,
    conversationId: persisted.conversationId,
    channelId: persisted.channelId,
    employeeId: persisted.employee?.id,
    employeeName: persisted.employee?.name ?? 'AI Assistant',
    employeeRole: persisted.employee?.role ?? 'Support',
    employeePersona: employeePersonaText(persisted.employee?.persona),
    toolAllowlist: parseToolAllowlist(persisted.employee?.tool_allowlist),
    connectedChannels: persisted.connectedChannels,
    userMessage: input.content,
    inboundEventId: input.providerMessageId || undefined,
    channelKey: input.channelKey,
    replyTarget: replyTargetFromChannelMeta(input.channelType, input.contactId, persisted.chanMeta),
  };
}

export function isRegisteredOwnerPhone(from: string, meta: Record<string, unknown>): boolean {
  const digits = from.replace(/\D/g, '');
  const candidates: string[] = [];
  for (const key of ['owner_phone', 'ownerPhone', 'registered_number', 'registeredNumber'] as const) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) candidates.push(value.replace(/\D/g, ''));
  }
  const list = meta.owner_phones ?? meta.registered_numbers;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string') candidates.push(item.replace(/\D/g, ''));
    }
  }
  if (candidates.length === 0) return false;
  return candidates.some((c) => c === digits || c.endsWith(digits) || digits.endsWith(c));
}
