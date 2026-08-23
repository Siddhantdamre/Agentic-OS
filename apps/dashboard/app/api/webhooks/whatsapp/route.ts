import { NextResponse } from 'next/server';
import { pool, getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { assertMetaWebhookSignature } from '@/lib/webhook-crypto';
import {
  employeePersonaText,
  fireInboundAgent,
  parseToolAllowlist,
} from '@/lib/inbound-agent';
import { replyTargetFromChannelMeta } from '@/lib/channel-outbound';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';
import { resolveChannelByMeta } from '@/lib/channel-normalize';

/**
 * GET /api/webhooks/whatsapp
 * Meta webhook verification challenge handler.
 * H1 Meta token rotation is ops — see infra/scripts/OPERATOR_HYGIENE.md §4.
 * Never commit META_ACCESS_TOKEN. Revoked Graph ≠ {success:true}.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const verifyToken = process.env.VERIFY_TOKEN;

    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      return new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return new NextResponse('Forbidden', { status: 403 });
  } catch (error) {
    console.error('[WhatsApp Webhook] GET error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

type ChannelRow = { id: string; org_id: string; meta: Record<string, unknown> };

async function lookupWhatsAppByPhone(phoneNumberId: string | null): Promise<ChannelRow | null> {
  if (!phoneNumberId) return null;
  try {
    const res = await pool.query(
      `SELECT id, org_id, meta FROM resolve_whatsapp_channel($1)`,
      [phoneNumberId]
    );
    return (res.rows[0] as ChannelRow) ?? null;
  } catch {
    const res = await pool.query(
      `SELECT id, org_id, meta FROM channels
       WHERE channel_type = 'whatsapp'
         AND (meta->>'phone_number_id' = $1 OR meta->>'phoneNumberId' = $1)
       ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
      [phoneNumberId]
    );
    return (res.rows[0] as ChannelRow) ?? null;
  }
}

async function lookupWhatsAppByWaba(wabaId: string | null): Promise<ChannelRow | null> {
  if (!wabaId) return null;
  try {
    const res = await pool.query(
      `SELECT id, org_id, meta FROM resolve_whatsapp_channel_by_waba($1)`,
      [wabaId]
    );
    return (res.rows[0] as ChannelRow) ?? null;
  } catch {
    const res = await pool.query(
      `SELECT id, org_id, meta FROM channels
       WHERE channel_type = 'whatsapp'
         AND (meta->>'whatsapp_business_account_id' = $1 OR meta->>'wabaId' = $1)
       ORDER BY connected_at DESC NULLS LAST LIMIT 1`,
      [wabaId]
    );
    return (res.rows[0] as ChannelRow) ?? null;
  }
}

async function lookupSingleOrgWhatsApp(): Promise<ChannelRow | null> {
  try {
    const res = await pool.query(`SELECT id, org_id, meta FROM resolve_single_org_whatsapp_channel()`);
    return (res.rows[0] as ChannelRow) ?? null;
  } catch {
    // The fallback used to COUNT(*) FROM orgs directly. `orgs` is behind RLS
    // now (migration 028), so that read returns 0 for an unscoped connection
    // and this path would refuse every message while looking exactly like
    // "not a single-org deployment". single_active_org_id() is the supported
    // way to ask the same question, and returns NULL once a second org exists.
    const sole = await pool.query(`SELECT single_active_org_id() AS id`);
    if (!sole.rows[0]?.id) return null;
    const res = await pool.query(
      `SELECT id, org_id, meta FROM channels
       WHERE channel_type = 'whatsapp' AND status IN ('active', 'connected')
       ORDER BY connected_at DESC NULLS LAST LIMIT 1`
    );
    return (res.rows[0] as ChannelRow) ?? null;
  }
}

function inboundText(message: Record<string, unknown>): string {
  const textObj = message.text as { body?: string } | undefined;
  if (typeof textObj?.body === 'string' && textObj.body.trim()) return textObj.body;
  const type = typeof message.type === 'string' ? message.type : 'media';
  const image = message.image as { caption?: string } | undefined;
  const video = message.video as { caption?: string } | undefined;
  const document = message.document as { caption?: string } | undefined;
  const caption = image?.caption || video?.caption || document?.caption;
  if (caption && caption.trim()) return caption;
  return `[${type} message]`;
}

/**
 * POST /api/webhooks/whatsapp
 * Persist inbound message, return 200, then fire-and-forget Temporal.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const sigHeader = req.headers.get('x-hub-signature-256');
  const sig = assertMetaWebhookSignature(rawBody, sigHeader);
  if (!sig.ok) {
    return new NextResponse(sig.error || 'Unauthorized', { status: sig.status });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new NextResponse('OK', { status: 200 });
  }

  if (body.object !== 'whatsapp_business_account') {
    return new NextResponse('OK', { status: 200 });
  }

  const entries = (body.entry as unknown[]) || [];
  const agentJobs: Array<Parameters<typeof fireInboundAgent>[0]> = [];

  for (const entry of entries) {
    const entryWabaId = typeof (entry as { id?: unknown })?.id === 'string' ? (entry as { id: string }).id : null;
    const changes = ((entry as { changes?: unknown[] })?.changes) || [];
    for (const change of changes) {
      const value = ((change as { value?: Record<string, unknown> })?.value) || {};
      const messages = (value.messages as Record<string, unknown>[]) || [];
      const metadata = (value.metadata as Record<string, unknown>) || {};

      for (const message of messages) {
        const from = typeof message.from === 'string' ? message.from : '';
        const messageId = typeof message.id === 'string' ? message.id : '';
        const text = inboundText(message);
        if (!from) continue;

        try {
          const inboundPhoneNumberId =
            (typeof metadata.phone_number_id === 'string' && metadata.phone_number_id) ||
            process.env.WHATSAPP_PHONE_NUMBER_ID ||
            null;
          const wabaId =
            entryWabaId ||
            process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ||
            null;

          const matched =
            (await lookupWhatsAppByPhone(inboundPhoneNumberId)) ||
            (await lookupWhatsAppByWaba(wabaId)) ||
            (await lookupSingleOrgWhatsApp());

          if (!matched?.org_id) {
            console.error('[WhatsApp Webhook] Cannot resolve org — skipping message from', from);
            continue;
          }

          const ownerChannel =
            (await resolveChannelByMeta('owner_whatsapp', 'phone_number_id', inboundPhoneNumberId || '')) ||
            (await resolveChannelByMeta('owner_whatsapp', 'phoneNumberId', inboundPhoneNumberId || ''));
          if (ownerChannel) {
            console.warn('[WhatsApp Webhook] Owner number delivered here — skipping customer ingest');
            continue;
          }

          const orgId = matched.org_id;
          const webhookLimited = denyWebhookIfLimited(orgId);
          if (webhookLimited) {
            return webhookLimited;
          }
          let channelId = matched.id;
          const chanMeta = (matched.meta || {}) as Record<string, unknown>;
          const { client } = await getOrgScopedClient(orgId);
          try {
            if (!channelId) {
              const newChan = await client.query(
                `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
                 VALUES ($1, 'whatsapp', 'active', $2, NOW()) RETURNING id`,
                [
                  orgId,
                  JSON.stringify({
                    whatsapp_business_account_id: wabaId,
                    phone_number_id: inboundPhoneNumberId,
                  }),
                ]
              );
              channelId = newChan.rows[0].id;
            }

            const empRes = await client.query(
              `SELECT id, name, role, persona, tool_allowlist FROM ai_employees
               WHERE org_id = $1 AND status = 'active' LIMIT 1`,
              [orgId]
            );
            const employee = empRes.rows[0];

            const connectedRes = await client.query(
              `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('active', 'connected')`,
              [orgId]
            );
            const connectedChannels = connectedRes.rows.map((row: { channel_type: string }) => row.channel_type);

            let conversationId: string;
            const existingConv = await client.query(
              `SELECT id FROM conversations WHERE org_id = $1 AND contact_id = $2 AND status != 'resolved' LIMIT 1`,
              [orgId, from]
            );

            if (existingConv.rows.length > 0) {
              conversationId = existingConv.rows[0].id;
              await client.query(
                `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
                [text.slice(0, 100), conversationId, orgId]
              );
            } else {
              const newConv = await client.query(
                `INSERT INTO conversations (org_id, channel_id, contact_id, employee_id, status, summary, metadata, started_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'open', $5, $6, NOW(), NOW())
                 RETURNING id`,
                [
                  orgId,
                  channelId,
                  from,
                  employee?.id ?? null,
                  text.slice(0, 100),
                  JSON.stringify({ sender_name: from, channel: 'whatsapp' }),
                ]
              );
              conversationId = newConv.rows[0].id;
            }

            let inserted = true;
            if (messageId) {
              const dup = await client.query(
                `SELECT id FROM messages WHERE org_id = $1 AND chatwoot_msg_id = $2 LIMIT 1`,
                [orgId, messageId]
              );
              if (dup.rows.length > 0) {
                inserted = false;
              }
            }
            if (inserted) {
              try {
                await client.query(
                  `INSERT INTO messages (org_id, conversation_id, role, content, chatwoot_msg_id, channel_key, created_at)
                   VALUES ($1, $2, 'user', $3, $4, 'whatsapp', NOW())`,
                  [orgId, conversationId, text, messageId || null]
                );
              } catch (insertErr: unknown) {
                const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
                if (msg.includes('idx_messages_org_chatwoot_msg_id') || msg.includes('unique')) {
                  inserted = false;
                } else {
                  throw insertErr;
                }
              }
            }

            if (!inserted) {
              continue;
            }

            await client.query(
              `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
               VALUES ($1, 'whatsapp', 'inbound_message', 'success', 200, $2, $3)`,
              [orgId, `Inbound WhatsApp from ${from}`, JSON.stringify({ from, messageId, text: text.slice(0, 300) })]
            );

            realtimeHub.publish(orgId, {
              type: 'needs_attention',
              conversationId,
              message: text.slice(0, 200),
              contactId: from,
              channelType: 'whatsapp',
            });

            agentJobs.push({
              orgId,
              conversationId,
              channelId,
              employeeId: employee?.id,
              employeeName: employee?.name ?? 'AI Assistant',
              employeeRole: employee?.role ?? 'Support',
              employeePersona: employeePersonaText(employee?.persona),
              toolAllowlist: parseToolAllowlist(employee?.tool_allowlist),
              connectedChannels,
              userMessage: text,
              inboundEventId: messageId || undefined,
              channelKey: 'whatsapp',
              replyTarget: replyTargetFromChannelMeta('whatsapp', from, chanMeta),
            });
          } finally {
            client.release();
          }
        } catch (dbErr: unknown) {
          if (isRateLimitError(dbErr)) {
            return responseFromRateLimit(dbErr);
          }
          const message = dbErr instanceof Error ? dbErr.message : String(dbErr);
          console.error('[WhatsApp Webhook] Processing error:', message);
        }
      }
    }
  }

  for (const job of agentJobs) {
    fireInboundAgent(job);
  }

  return new NextResponse('OK', { status: 200 });
}
