import { NextResponse } from 'next/server';
import { pool, getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { assertChatwootWebhookSignature } from '@/lib/webhook-crypto';
import {
  employeePersonaText,
  fireInboundAgent,
  parseToolAllowlist,
} from '@/lib/inbound-agent';
import { replyTargetFromChannelMeta } from '@/lib/channel-outbound';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';
import {
  normalizeChannelKey,
  resolveOrgByChatwootInbox,
  upsertChatwootInboxMap,
} from '@/lib/channel-normalize';
import { resolvePersonId } from '@/lib/resolve-person';

type ChatwootEvent =
  | 'message_created'
  | 'message_updated'
  | 'conversation_created'
  | 'conversation_status_changed'
  | 'ignored';

function classifyEvent(event: string): ChatwootEvent {
  switch (event) {
    case 'message_created':
      return 'message_created';
    case 'message_updated':
      return 'message_updated';
    case 'conversation_created':
      return 'conversation_created';
    case 'conversation_status_changed':
      return 'conversation_status_changed';
    default:
      return 'ignored';
  }
}

function coerceAccountId(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function parseChatwootConvId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

type NormalizedInbound = {
  skipAgent: boolean;
  ignore: boolean;
  channelType: string;
  chatwootConvId: number | null;
  chatwootMsgId: string | null;
  contactId: string;
  senderName: string;
  content: string;
  employeeId: string | null;
  meta: Record<string, unknown>;
  chatwootAccountId: string | number | null;
  viaChatwootApi: boolean;
};

function isOutgoingMessage(payload: Record<string, unknown>): boolean {
  const messageType = payload.message_type;
  if (messageType === 'outgoing' || messageType === 1 || messageType === '1') return true;
  if (payload.private === true) return true;
  const sender = payload.sender as { type?: string } | undefined;
  if (sender?.type === 'user') return true;
  return false;
}

function normalizeInbound(payload: Record<string, unknown>): NormalizedInbound {
  const conversation = (payload.conversation as Record<string, unknown> | undefined) || {};
  const sender = (payload.sender as Record<string, unknown> | undefined) || {};
  const account = (payload.account as Record<string, unknown> | undefined) || {};
  const contactInbox = (conversation.contact_inbox as Record<string, unknown> | undefined) || {};

  const nativeContent = typeof payload.content === 'string' ? payload.content : '';
  const darexContent = nativeContent || 'Inbound message';

  const contactId =
    (typeof payload.contact_id === 'string' && payload.contact_id) ||
    (typeof sender.phone_number === 'string' && sender.phone_number) ||
    (typeof sender.email === 'string' && sender.email) ||
    (typeof contactInbox.source_id === 'string' && contactInbox.source_id) ||
    (sender.id != null ? String(sender.id) : '');

  const senderName =
    (typeof payload.sender_name === 'string' && payload.sender_name) ||
    (typeof sender.name === 'string' && sender.name) ||
    'Customer';

  const channelFromNative =
    typeof conversation.channel === 'string'
      ? conversation.channel.replace(/^Channel::/i, '').toLowerCase()
      : null;
  const channelType =
    (typeof payload.channel_type === 'string' && payload.channel_type) ||
    channelFromNative ||
    'whatsapp';

  const chatwootConvId = parseChatwootConvId(payload.chatwoot_conv_id ?? conversation.id);
  const chatwootMsgId =
    payload.chatwoot_msg_id != null
      ? String(payload.chatwoot_msg_id)
      : payload.id != null
        ? String(payload.id)
        : null;

  const employeeId = typeof payload.employee_id === 'string' ? payload.employee_id : null;
  const extraMeta = (payload.meta as Record<string, unknown> | undefined) || {};

  return {
    skipAgent: isOutgoingMessage(payload),
    ignore: false,
    channelType,
    chatwootConvId,
    chatwootMsgId,
    contactId,
    senderName,
    content: darexContent,
    employeeId,
    meta: extraMeta,
    chatwootAccountId: coerceAccountId(account.id) ?? coerceAccountId(extraMeta.chatwoot_account_id),
    viaChatwootApi: conversation.id != null,
  };
}

async function resolveOrgFromRequest(
  request: Request,
  payload: Record<string, unknown>
): Promise<{ orgId: string | null; via: 'inbox_map' | 'secret' | 'header' | 'single_org' | 'query' | null }> {
  void payload.org_id;
  void payload.orgId;

  const conversation = (payload.conversation as Record<string, unknown> | undefined) || {};
  const inbox = (payload.inbox as Record<string, unknown> | undefined) || {};
  const account = (payload.account as Record<string, unknown> | undefined) || {};
  const inboxId = parseChatwootConvId(payload.inbox_id ?? inbox.id ?? conversation.inbox_id);
  const accountId = coerceAccountId(account.id) ?? coerceAccountId(inbox.account_id);

  // PRECEDENCE: an authenticated credential beats the inbox map, always.
  //
  // The inbox map is keyed on `account.id` / `inbox_id` taken from the request
  // BODY — values the sender picks. It is a routing *hint*, useful when Chatwoot
  // sends nothing else, but it proves nothing. A per-org webhook secret does
  // prove which org is calling. Proof outranks hint.
  //
  // This ordering is not theoretical. A test harness that reused
  // `account:{id:1}, inbox_id:1` across tenants had every tenant's traffic
  // routed to whichever org registered inbox 1 first — even though each request
  // carried its own valid per-org token, because the map was consulted first.
  // The same collision happens in production whenever two orgs connect
  // Chatwoot instances that both number their first inbox 1.
  const mapped = await resolveOrgByChatwootInbox(accountId, inboxId);

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token) {
    // No raw-SQL fallback behind this. `orgs` is behind RLS (migration 028)
    // and the catch block used to do exactly the unscoped read the SECURITY
    // DEFINER resolver exists to prevent — a hole that opened whenever the
    // function call failed for any reason at all.
    const res = await pool.query(`SELECT resolve_org_by_webhook_secret($1) AS id`, [token]);
    const secretOrg = (res.rows[0]?.id as string) || null;
    if (secretOrg) {
      warnOnOrgConflict(mapped, secretOrg, 'secret', accountId, inboxId);
      return { orgId: secretOrg, via: 'secret' };
    }
  }

  // `?org_id=` is only trusted alongside a per-org secret (`?token=` matched against
  // that org's own webhook_secret) — the global CHATWOOT_WEBHOOK_SECRET already
  // verified in POST() is shared across all orgs, so org_id alone would let anyone
  // holding it target any org by guessing/enumerating ids.
  const url = new URL(request.url);
  const orgIdParam = url.searchParams.get('org_id');
  const queryToken = url.searchParams.get('token');
  if (orgIdParam && queryToken) {
    const res = await pool.query(
      `SELECT org_resolve_by_id_and_secret($1::uuid, $2::text) AS id`,
      [orgIdParam, queryToken]
    );
    if (res.rows[0]?.id) {
      const queryOrg = res.rows[0].id as string;
      warnOnOrgConflict(mapped, queryOrg, 'query', accountId, inboxId);
      return { orgId: queryOrg, via: 'query' };
    }
  }

  // A per-org credential was PRESENTED and did not validate. Stop here.
  //
  // Previously this fell through to the inbox map, and the consequence was
  // measured, not theorised: posting `?org_id=<B>&token=<A's token>` was
  // correctly refused for B, then silently routed into a THIRD org — whichever
  // one happened to own the stale map row for the account/inbox ids in the
  // payload body. The caller chose those ids.
  //
  // The global CHATWOOT_WEBHOOK_SECRET that signs the request is shared by
  // every tenant, so a valid signature says "this came from our Chatwoot",
  // never "this came from org X". Once a caller makes a per-org identity claim,
  // that claim is the request's identity: if it fails, the request fails.
  // Redirecting a failed authentication somewhere else is never correct.
  const attemptedOrgAuth = Boolean(token) || Boolean(orgIdParam) || Boolean(queryToken);
  if (attemptedOrgAuth) {
    console.warn(
      `[Chatwoot Webhook] REJECTED — a per-org credential was presented and did not validate `
        + `(org_id param=${orgIdParam || 'none'}, bearer=${token ? 'present' : 'none'}, `
        + `query token=${queryToken ? 'present' : 'none'}). Refusing to fall back to the inbox map `
        + `for account=${accountId} inbox=${inboxId}.`
    );
    return { orgId: null, via: null };
  }

  // No identity was claimed at all — fall back to the hint.
  if (mapped) return { orgId: mapped, via: 'inbox_map' };

  // X-Darex-Org-Id is an id, not a credential, so it ranks BELOW the inbox map:
  // anyone holding the shared global signing secret can set it to any org id.
  const orgHeader = request.headers.get('X-Darex-Org-Id');
  if (orgHeader) {
    const res = await pool.query(`SELECT resolve_active_org($1::uuid) AS id`, [orgHeader]);
    if (res.rows[0]?.id) return { orgId: res.rows[0].id as string, via: 'header' };
  }

  // Exactly one active org on the deployment: a development convenience, and
  // single_active_org_id() returns NULL the moment a second org exists, so it
  // can never silently pick a tenant on a real deployment.
  const sole = await pool.query(`SELECT single_active_org_id() AS id`);
  if (sole.rows[0]?.id) return { orgId: sole.rows[0].id as string, via: 'single_org' };

  return { orgId: null, via: null };
}

/**
 * Loud when the inbox map and an authenticated credential disagree.
 *
 * Neither side is ignored silently: the credential wins the routing decision
 * and the disagreement is logged, because it means either two orgs share
 * account/inbox numbering or a stale map row is pointing at the wrong tenant.
 * Both need a human to look.
 */
function warnOnOrgConflict(
  mapped: string | null,
  authenticated: string,
  via: 'secret' | 'query',
  accountId: string | number | null,
  inboxId: string | number | null
): void {
  if (!mapped || mapped === authenticated) return;
  console.warn(
    `[Chatwoot Webhook] ORG ROUTING CONFLICT — inbox map (account=${accountId} inbox=${inboxId}) `
      + `resolves org ${mapped} but the authenticated ${via} credential belongs to org ${authenticated}. `
      + `Using the authenticated org (${authenticated}); the inbox map entry is stale or account/inbox `
      + `ids collide across tenants. Fix the chatwoot_inbox_map row for account=${accountId} inbox=${inboxId}.`
  );
}

export async function POST(request: Request) {
  const startTime = Date.now();
  const rawBody = await request.text();

  const sig = assertChatwootWebhookSignature(rawBody, request.headers.get('x-chatwoot-signature'));
  if (!sig.ok) {
    return NextResponse.json({ error: sig.error || 'Invalid webhook signature' }, { status: sig.status });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const eventName = typeof payload.event === 'string' ? payload.event : 'message_created';
  const event = classifyEvent(eventName);
  switch (event) {
    case 'ignored':
    case 'conversation_created':
    case 'conversation_status_changed':
    case 'message_updated':
      return NextResponse.json({ success: true, ignored: true, event: eventName });
    case 'message_created':
      break;
    default: {
      const _never: never = event;
      return NextResponse.json({ success: true, ignored: true, event: String(_never) });
    }
  }

  const inbound = normalizeInbound(payload);
  if (!inbound.contactId) {
    return NextResponse.json(
      { error: 'contact_id is required in webhook payload for multi-tenant routing' },
      { status: 400 }
    );
  }

  const resolved = await resolveOrgFromRequest(request, payload);
  const orgId = resolved.orgId;
  if (!orgId) {
    console.error('[Chatwoot Webhook] Cannot resolve org_id — webhook must include inbox map, auth token, or org_id param');
    return NextResponse.json(
      { error: 'Cannot resolve organization. Map the Chatwoot inbox to an org, or include Authorization header.' },
      { status: 400 }
    );
  }

  const webhookLimited = denyWebhookIfLimited(orgId);
  if (webhookLimited) {
    return webhookLimited;
  }

  const { client } = await getOrgScopedClient(orgId);
  let conversationId = '';
  let messageId = '';
  let channelId: string | null = null;
  let employee: { id?: string; name?: string; role?: string; persona?: unknown; tool_allowlist?: unknown } | undefined;
  let connectedChannels: string[] = [];
  let chanMeta: Record<string, unknown> = {};
  let shouldFireAgent = !inbound.skipAgent;
  const channelKey = normalizeChannelKey(inbound.channelType);

  try {
    if (resolved.via && resolved.via !== 'query' && resolved.via !== 'inbox_map') {
      const conversation = (payload.conversation as Record<string, unknown> | undefined) || {};
      const inbox = (payload.inbox as Record<string, unknown> | undefined) || {};
      const inboxId = parseChatwootConvId(payload.inbox_id ?? inbox.id ?? conversation.inbox_id);
      try {
        await upsertChatwootInboxMap(client, orgId, inbound.chatwootAccountId, inboxId);
      } catch (mapErr: unknown) {
        const message = mapErr instanceof Error ? mapErr.message : String(mapErr);
        console.warn('[Chatwoot Webhook] inbox map upsert skipped:', message);
      }
    }
    const channelRes = await client.query(
      `SELECT id, meta FROM channels WHERE org_id = $1 AND channel_type = $2 LIMIT 1`,
      [orgId, inbound.channelType]
    );

    if (channelRes.rows.length > 0) {
      channelId = channelRes.rows[0].id;
      chanMeta = (channelRes.rows[0].meta || {}) as Record<string, unknown>;
    } else {
      const newChan = await client.query(
        `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
         VALUES ($1, $2, 'active', $3, NOW()) RETURNING id, meta`,
        [orgId, inbound.channelType, JSON.stringify({ name: `${inbound.channelType} Channel` })]
      );
      channelId = newChan.rows[0].id;
      chanMeta = (newChan.rows[0].meta || {}) as Record<string, unknown>;
    }

    const existingConv = inbound.chatwootConvId
      ? await client.query(
          `SELECT id, status FROM conversations WHERE org_id = $1 AND chatwoot_conv_id = $2 LIMIT 1`,
          [orgId, inbound.chatwootConvId]
        )
      : await client.query(
          `SELECT id, status FROM conversations WHERE org_id = $1 AND contact_id = $2 AND status != 'resolved' LIMIT 1`,
          [orgId, inbound.contactId]
        );

    const empRes = await client.query(
      `SELECT id, name, role, persona, tool_allowlist FROM ai_employees WHERE org_id = $1 AND status = 'active' LIMIT 1`,
      [orgId]
    );
    employee = empRes.rows[0];
    let assignedEmployeeId = employee?.id ?? null;
    if (inbound.employeeId) {
      const requested = await client.query(
        `SELECT id FROM ai_employees WHERE org_id = $1 AND id = $2 LIMIT 1`,
        [orgId, inbound.employeeId]
      );
      if (requested.rows[0]?.id) assignedEmployeeId = requested.rows[0].id;
    }

    const connectedRes = await client.query(
      `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
      [orgId]
    );
    connectedChannels = connectedRes.rows.map((row: { channel_type: string }) => row.channel_type);

    const metadata = {
      sender_name: inbound.senderName,
      chatwoot_account_id: inbound.chatwootAccountId,
      ...inbound.meta,
    };

    if (existingConv.rows.length > 0) {
      conversationId = existingConv.rows[0].id;
      await client.query(
        `UPDATE conversations SET updated_at = NOW(), summary = $1, metadata = metadata || $2::jsonb WHERE id = $3 AND org_id = $4`,
        [inbound.content.slice(0, 100), JSON.stringify(metadata), conversationId, orgId]
      );
    } else {
      const newConv = await client.query(
        `INSERT INTO conversations (org_id, channel_id, chatwoot_conv_id, status, contact_id, employee_id, summary, metadata, started_at, updated_at, person_id)
         VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, NOW(), NOW(), $8)
         RETURNING id`,
        [
          orgId,
          channelId,
          inbound.chatwootConvId,
          inbound.contactId,
          assignedEmployeeId,
          inbound.content.slice(0, 100),
          JSON.stringify(metadata),
          await resolvePersonId(client, orgId, inbound.contactId, inbound.channelType),
        ]
      );
      conversationId = newConv.rows[0].id;
    }

    if (inbound.chatwootMsgId) {
      const dup = await client.query(
        `SELECT id FROM messages WHERE org_id = $1 AND chatwoot_msg_id = $2 LIMIT 1`,
        [orgId, inbound.chatwootMsgId]
      );
      if (dup.rows.length > 0) {
        messageId = dup.rows[0].id;
        shouldFireAgent = false;
      }
    }

    if (!messageId) {
      try {
        const msgRes = await client.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, chatwoot_msg_id, channel_key, created_at)
           VALUES ($1, $2, 'user', $3, $4, $5, NOW())
           RETURNING id, created_at`,
          [orgId, conversationId, inbound.content, inbound.chatwootMsgId, channelKey]
        );
        messageId = msgRes.rows[0].id;
      } catch (insertErr: unknown) {
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (inbound.chatwootMsgId && (msg.includes('idx_messages_org_chatwoot_msg_id') || msg.includes('unique'))) {
          const raced = await client.query(
            `SELECT id FROM messages WHERE org_id = $1 AND chatwoot_msg_id = $2 LIMIT 1`,
            [orgId, inbound.chatwootMsgId]
          );
          messageId = raced.rows[0]?.id || '';
          shouldFireAgent = false;
        } else {
          throw insertErr;
        }
      }
    }

    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, 'inbound_message', 'success', 200, $3, $4)`,
      [
        orgId,
        inbound.channelType,
        `Inbound message from ${inbound.senderName} (${inbound.contactId})`,
        JSON.stringify({ conversationId, messageId, content: inbound.content.slice(0, 300) }),
      ]
    );

    realtimeHub.publish(orgId, {
      type: 'needs_attention',
      conversationId,
      message: inbound.content.slice(0, 200),
      contactId: inbound.contactId,
      channelType: inbound.channelType,
    });
  } catch (err: unknown) {
    if (isRateLimitError(err)) {
      return responseFromRateLimit(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('Chatwoot Webhook Ingestion Error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    client.release();
  }

  if (shouldFireAgent) {
    fireInboundAgent({
      orgId,
      conversationId,
      channelId: channelId ?? undefined,
      employeeId: employee?.id,
      employeeName: employee?.name ?? 'AI Assistant',
      employeeRole: employee?.role ?? 'Support',
      employeePersona: employeePersonaText(employee?.persona),
      toolAllowlist: parseToolAllowlist(employee?.tool_allowlist),
      connectedChannels,
      userMessage: inbound.content,
      inboundEventId: inbound.chatwootMsgId || undefined,
      channelKey,
      replyTarget: replyTargetFromChannelMeta(
        inbound.viaChatwootApi ? 'chatwoot' : inbound.channelType,
        inbound.contactId,
        { ...chanMeta, chatwoot_account_id: inbound.chatwootAccountId ?? chanMeta.chatwoot_account_id },
        { chatwootConvId: inbound.chatwootConvId }
      ),
    });
  }

  return NextResponse.json({
    success: true,
    latencyMs: Date.now() - startTime,
    org_id: orgId,
    conversation_id: conversationId,
    message_id: messageId,
    event: eventName,
    channel_type: inbound.channelType,
  });
}
