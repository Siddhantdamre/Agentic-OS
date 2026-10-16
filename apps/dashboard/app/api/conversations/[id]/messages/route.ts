import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import { realtimeHub } from '@/lib/realtime-hub';
import type { PoolClient } from 'pg';
import {
  employeePersonaText,
  fireInboundAgent,
  parseToolAllowlist,
} from '@/lib/inbound-agent';
import { replyTargetFromChannelMeta, sendChannelReply } from '@/lib/channel-outbound';
import { DEFAULT_AUTO_REPLY, parseAutoReply } from '@/lib/whatsapp-auto-reply-config';
import { recordOutboundDelivery } from '@/lib/failed-webhooks';
import { safeHttpUrl } from '@/lib/safe-url';
import { canActOnConversations, loadHumanRole } from '@/lib/rbac';
import { auditConversationAction } from '@/lib/conversation-audit';
import { publicErrorMessage } from '@/lib/public-error';

type MessageRole = 'user' | 'customer' | 'human_agent' | 'assistant';
/** Canonical roles returned by the API (inbound customer traffic is always `user`). */
type ApiMessageRole = 'user' | 'human_agent' | 'assistant';

type Attachment = { type: string; url: string; name?: string; mime?: string };

function normalizeRole(role: unknown): MessageRole | null {
  switch (role) {
    case 'user':
      return 'user';
    case 'customer':
      return 'customer';
    case 'human_agent':
      return 'human_agent';
    case 'assistant':
      return 'assistant';
    case undefined:
      return 'user';
    default:
      return null;
  }
}

/** Map stored / input roles to the API-facing canonical set without rewriting history. */
function toApiRole(role: unknown): ApiMessageRole {
  switch (role) {
    case 'customer':
    case 'user':
      return 'user';
    case 'human_agent':
      return 'human_agent';
    case 'assistant':
      return 'assistant';
    default:
      return 'user';
  }
}

function parseAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    // http(s) only: `javascript:` / `data:` hrefs would run in the operator's inbox (CH-S04).
    const url = typeof row.url === 'string' && row.url.length <= 2000 ? safeHttpUrl(row.url) : null;
    if (!url) continue;
    if (typeof row.type !== 'string' || !row.type.trim()) continue;
    out.push({
      type: row.type.trim().slice(0, 40),
      url,
      name: typeof row.name === 'string' ? row.name.slice(0, 200) : undefined,
      mime: typeof row.mime === 'string' ? row.mime.slice(0, 100) : undefined,
    });
    if (out.length >= 20) break;
  }
  return out;
}

// GET message history for a conversation
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await params;
    const { client, orgId } = await getScopedClient();
    const url = new URL(request.url);
    const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 200;
    const beforeParam = url.searchParams.get('before');
    const before = beforeParam && !Number.isNaN(Date.parse(beforeParam)) ? beforeParam : null;
    try {
      // Newest `limit` rows (optionally older than `before`), returned oldest-first.
      // `before` is a JS ISO timestamp (ms precision); the +1ms slack means the boundary
      // row may repeat, never skip. Clients dedupe by id.
      const messagesRes = await client.query(
        `SELECT * FROM (
           SELECT id, org_id, conversation_id, role, content, tool_calls, chatwoot_msg_id,
                  created_at, COALESCE(attachments, '[]'::jsonb) AS attachments,
                  COALESCE(is_internal, false) AS is_internal, delivery_status
           FROM messages
           WHERE org_id = $1 AND conversation_id = $2
             AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz + interval '1 millisecond')
           ORDER BY created_at DESC, id DESC
           LIMIT $4
         ) recent
         ORDER BY created_at ASC, id ASC`,
        [orgId, conversationId, before, limit]
      );

      const convRes = await client.query(
        `SELECT c.*, ch.channel_type, e.name as employee_name, e.role as employee_role
         FROM conversations c
         LEFT JOIN channels ch ON c.channel_id = ch.id
         LEFT JOIN ai_employees e ON c.employee_id = e.id
         WHERE c.org_id = $1 AND c.id = $2`,
        [orgId, conversationId]
      );

      if (convRes.rows.length === 0) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      // Opening a thread clears unread for this org's operators.
      await client.query(
        `UPDATE conversations SET unread_count = 0, updated_at = updated_at
         WHERE id = $1 AND org_id = $2 AND unread_count <> 0`,
        [conversationId, orgId]
      );

      const messages = messagesRes.rows.map((row) => ({
        ...row,
        role: toApiRole(row.role),
      }));

      return NextResponse.json({
        conversation: convRes.rows[0],
        messages,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const errorId = randomUUID();
    console.error('Messages GET Error:', errorId, err);
    return NextResponse.json({ error: 'Internal error', errorId }, { status: 500 });
  }
}

// POST message & trigger AI Model Response (TrueForge)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: conversationId } = await params;
    const body = await tryReadJson<Record<string, unknown>>(request);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const content = typeof body.content === 'string' ? body.content : '';
    const messageRole = normalizeRole(body.role);
    if (!messageRole) {
      return NextResponse.json(
        { error: 'Invalid role. Must be user, customer, human_agent, or assistant' },
        { status: 400 }
      );
    }

    const isInternal = body.isInternal === true || body.is_internal === true;
    const attachments = parseAttachments(body.attachments);

    if ((!content || !content.trim()) && attachments.length === 0) {
      return NextResponse.json({ error: 'Message content is required' }, { status: 400 });
    }

    const { client: clientPool, orgId, userId } = await getScopedClient();
    let client: PoolClient | null = clientPool;
    try {
      if (!canActOnConversations(await loadHumanRole(client, userId))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const convRes = await client.query(
        `SELECT c.id, c.channel_id, c.employee_id, c.contact_id, c.chatwoot_conv_id, c.metadata,
                c.status, c.ai_paused, c.ai_paused_until,
                ch.channel_type, ch.meta as channel_meta,
                e.name as employee_name, e.role as employee_role, e.persona as employee_persona,
                e.tool_allowlist as employee_tool_allowlist
         FROM conversations c
         LEFT JOIN channels ch ON c.channel_id = ch.id
         LEFT JOIN ai_employees e ON c.employee_id = e.id
         WHERE c.org_id = $1 AND c.id = $2`,
        [orgId, conversationId]
      );

      if (convRes.rows.length === 0) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
      }

      const conv = convRes.rows[0];
      const storedRole = messageRole === 'customer' ? 'user' : messageRole;
      const text = content.trim() || (attachments.length ? `[${attachments.length} attachment(s)]` : '');

      const userMsgRes = await client.query(
        `INSERT INTO messages (org_id, conversation_id, role, content, attachments, is_internal, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
         RETURNING id, org_id, conversation_id, role, content, chatwoot_msg_id, created_at,
                   attachments, is_internal`,
        [orgId, conversationId, storedRole, text, JSON.stringify(attachments), isInternal]
      );

      const isCustomer = messageRole === 'user' || messageRole === 'customer';
      const summary = text.slice(0, 100);

      if (messageRole === 'human_agent') {
        await auditConversationAction(
          { client, orgId },
          {
            userId,
            kind: 'conversation.reply',
            conversationId,
            payload: {
              messageId: userMsgRes.rows[0]?.id ?? null,
              internal: isInternal,
              attachments: attachments.length,
            },
          }
        );
        // How long the AI stays quiet after a teammate replies: the WhatsApp owner's setting, else 2 hours.
        const pauseHours =
          conv.channel_type === 'whatsapp'
            ? parseAutoReply((conv.channel_meta || {}).auto_reply).humanPauseHours
            : DEFAULT_AUTO_REPLY.humanPauseHours;
        await client.query(
          `UPDATE conversations
              SET updated_at = NOW(),
                  summary = $1,
                  ai_paused = CASE WHEN $4::int > 0 THEN true ELSE ai_paused END,
                  ai_paused_until = CASE WHEN $4::int > 0 THEN NOW() + make_interval(hours => $4::int) ELSE ai_paused_until END,
                  unread_count = 0,
                  status = CASE WHEN status = 'resolved' THEN 'pending_human' ELSE status END
            WHERE id = $2 AND org_id = $3`,
          [summary, conversationId, orgId, pauseHours]
        );
      } else if (isCustomer) {
        // Reopen resolved/closed threads on inbound customer reply (API path).
        await client.query(
          `UPDATE conversations
              SET updated_at = NOW(),
                  summary = $1,
                  unread_count = COALESCE(unread_count, 0) + 1,
                  status = CASE
                    WHEN status IN ('resolved', 'closed') THEN 'open'
                    ELSE status
                  END,
                  sla_deadline_at = CASE
                    WHEN status IN ('resolved', 'closed') OR sla_deadline_at IS NULL
                      THEN NOW() + INTERVAL '15 minutes'
                    ELSE sla_deadline_at
                  END
            WHERE id = $2 AND org_id = $3`,
          [summary, conversationId, orgId]
        );
      } else {
        await client.query(
          `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
          [summary, conversationId, orgId]
        );
      }

      const connectedRes = await client.query(
        `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
        [orgId]
      );
      const connectedChannels = connectedRes.rows.map((row: { channel_type: string }) => row.channel_type);

      const channelType = conv.channel_type ?? 'dashboard';
      const contactId = conv.contact_id ?? 'unknown';
      const chanMeta = (conv.channel_meta || {}) as Record<string, unknown>;
      const replyTarget = replyTargetFromChannelMeta(channelType, contactId, chanMeta, {
        chatwootConvId: conv.chatwoot_conv_id,
      });

      const pausedUntil = conv.ai_paused_until ? new Date(conv.ai_paused_until) : null;
      const aiPaused =
        conv.ai_paused === true || (pausedUntil != null && pausedUntil.getTime() > Date.now());

      if (isCustomer) {
        realtimeHub.publish(orgId, {
          type: 'needs_attention',
          conversationId,
          message: text.slice(0, 200),
          contactId,
          channelType,
        });
      } else {
        realtimeHub.publish(orgId, {
          type: 'conversation_updated',
          conversationId,
          message: text.slice(0, 200),
          contactId,
          channelType,
        });
      }

      client.release();
      client = null;

      switch (messageRole) {
        case 'user':
        case 'customer':
          // Respect human takeover lock for API-originated customer messages too.
          if (!aiPaused) {
            fireInboundAgent({
              orgId,
              conversationId,
              channelId: conv.channel_id ?? undefined,
              employeeId: conv.employee_id ?? undefined,
              employeeName: conv.employee_name || 'AI Assistant',
              employeeRole: conv.employee_role || 'Support',
              employeePersona: employeePersonaText(conv.employee_persona),
              toolAllowlist: parseToolAllowlist(conv.employee_tool_allowlist),
              connectedChannels,
              userMessage: text,
              replyTarget,
            });
          }
          break;
        case 'human_agent': {
          if (isInternal) break;
          let send: Awaited<ReturnType<typeof sendChannelReply>> | null = null;
          const humanMessageId: string | null = userMsgRes.rows[0]?.id ?? null;
          try {
            send = await sendChannelReply(orgId, replyTarget, text);
          } catch (e: unknown) {
            // The row is already stored; mark it failed so the inbox does not show it as sent (CH-B12).
            await recordOutboundDelivery({
              orgId,
              messageId: humanMessageId,
              result: {
                attempted: true,
                sent: false,
                statusCode: 0,
                message: publicErrorMessage(e, 'send failed'),
                body: '',
              },
            });
            return NextResponse.json(
              {
                error: 'Failed to deliver to channel',
                detail: e instanceof Error ? e.message : 'send failed',
                userMessage: {
                  ...userMsgRes.rows[0],
                  role: toApiRole(userMsgRes.rows[0]?.role),
                  delivery_status: 'failed',
                },
              },
              { status: 502 }
            );
          }
          await recordOutboundDelivery({ orgId, messageId: humanMessageId, result: send });
          if (send.attempted && !send.sent) {
            return NextResponse.json(
              {
                error: 'Channel delivery failed',
                detail: send.message,
                userMessage: {
                  ...userMsgRes.rows[0],
                  role: toApiRole(userMsgRes.rows[0]?.role),
                  delivery_status: 'failed',
                },
              },
              { status: 502 }
            );
          }
          break;
        }
        case 'assistant':
          break;
        default: {
          const _never: never = messageRole;
          void _never;
        }
      }

      const stored = userMsgRes.rows[0];
      return NextResponse.json({
        success: true,
        userMessage: stored ? { ...stored, role: toApiRole(stored.role) } : stored,
        aiResponse: null,
        aiPaused,
      });
    } finally {
      if (client) client.release();
    }
  } catch (err: any) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    const errorId = randomUUID();
    console.error('Messages POST Error:', errorId, err);
    return NextResponse.json({ error: 'Internal error', errorId }, { status: 500 });
  }
}
