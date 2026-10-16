import { assertMetaWebhookSignature, assertWebhookBodySize } from '@/lib/webhook-crypto';
import { recordFailedWebhook, updateMessageDeliveryStatus } from '@/lib/failed-webhooks';
import { fireInboundAgent } from '@/lib/inbound-agent';
import { ingestWhatsAppInbound, type WhatsAppMediaMeta } from '@/lib/whatsapp-inbound';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';
import { resolveChannelByMeta } from '@/lib/channel-normalize';
import { realtimeHub } from '@/lib/realtime-hub';
import { pool } from '@/lib/db';
import { NextResponse } from 'next/server';

/**
 * GET /api/webhooks/whatsapp
 * Meta webhook verification challenge handler.
 * H1 Meta token rotation is ops - see infra/scripts/OPERATOR_HYGIENE.md §4.
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

type ParsedInbound = {
  text: string;
  media: WhatsAppMediaMeta | null;
};

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

function mediaFromMessage(message: Record<string, unknown>): WhatsAppMediaMeta | null {
  const type = typeof message.type === 'string' ? message.type : '';
  switch (type) {
    case 'audio':
    case 'image':
    case 'video':
    case 'document':
    case 'sticker': {
      const blob = (message[type] as Record<string, unknown> | undefined) || {};
      return {
        type,
        id: typeof blob.id === 'string' ? blob.id : null,
        mimeType: typeof blob.mime_type === 'string' ? blob.mime_type : null,
        sha256: typeof blob.sha256 === 'string' ? blob.sha256 : null,
        filename: typeof blob.filename === 'string' ? blob.filename : null,
        caption: typeof blob.caption === 'string' ? blob.caption : null,
      };
    }
    default:
      return null;
  }
}

/**
 * Honest parse: text body, or caption + media id metadata.
 * Never invents transcripts for audio/image - only what the webhook carries.
 */
function parseInboundMessage(message: Record<string, unknown>): ParsedInbound {
  const media = mediaFromMessage(message);
  const textObj = message.text as { body?: string } | undefined;
  if (typeof textObj?.body === 'string' && textObj.body.trim()) {
    return { text: textObj.body, media: null };
  }
  if (media) {
    const parts = [`[${media.type} message]`];
    if (media.id) parts.push(`media_id=${media.id}`);
    if (media.mimeType) parts.push(`mime=${media.mimeType}`);
    if (media.filename) parts.push(`filename=${media.filename}`);
    if (media.caption?.trim()) parts.push(media.caption.trim());
    return { text: parts.join(' '), media };
  }
  const type = typeof message.type === 'string' ? message.type : 'unknown';
  return { text: `[${type} message]`, media: null };
}

/**
 * POST /api/webhooks/whatsapp
 * Persist inbound message, return 200, then fire-and-forget Temporal.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const size = assertWebhookBodySize(req, rawBody);
  if (!size.ok) {
    await recordFailedWebhook({
      channel: 'whatsapp',
      headers: req.headers,
      rawPayload: rawBody,
      errorMessage: size.error || 'body too large',
    });
    return new NextResponse(size.error || 'Payload Too Large', { status: size.status });
  }
  const sigHeader = req.headers.get('x-hub-signature-256');
  const sig = assertMetaWebhookSignature(rawBody, sigHeader);
  if (!sig.ok) {
    await recordFailedWebhook({
      channel: 'whatsapp',
      headers: req.headers,
      rawPayload: rawBody,
      errorMessage: sig.error || 'Unauthorized',
    });
    return new NextResponse(sig.error || 'Unauthorized', { status: sig.status });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    await recordFailedWebhook({
      channel: 'whatsapp',
      headers: req.headers,
      rawPayload: rawBody,
      errorMessage: 'Invalid JSON',
    });
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
      const statuses = (value.statuses as Record<string, unknown>[]) || [];
      const metadata = (value.metadata as Record<string, unknown>) || {};

      // Delivery receipts (sent / delivered / read) — no agent enqueue.
      for (const statusRow of statuses) {
        const wamid = typeof statusRow.id === 'string' ? statusRow.id : '';
        const statusRaw = typeof statusRow.status === 'string' ? statusRow.status.toLowerCase() : '';
        const ts = statusRow.timestamp;
        let delivery: 'sent' | 'delivered' | 'read' | 'failed' | null = null;
        switch (statusRaw) {
          case 'sent':
            delivery = 'sent';
            break;
          case 'delivered':
            delivery = 'delivered';
            break;
          case 'read':
            delivery = 'read';
            break;
          case 'failed':
            delivery = 'failed';
            break;
          default:
            delivery = null;
        }
        if (!wamid || !delivery) continue;
        const inboundPhoneNumberId =
          (typeof metadata.phone_number_id === 'string' && metadata.phone_number_id) || null;
        const matched =
          (await lookupWhatsAppByPhone(inboundPhoneNumberId)) ||
          (await lookupWhatsAppByWaba(entryWabaId));
        if (!matched?.org_id) continue;
        try {
          const updated = await updateMessageDeliveryStatus({
            orgId: matched.org_id,
            providerMessageId: wamid,
            status: delivery,
            timestampSec: typeof ts === 'string' || typeof ts === 'number' ? ts : null,
          });
          if (updated) {
            realtimeHub.publish(matched.org_id, {
              type: 'message_status_updated',
              conversationId: undefined,
              message: delivery,
              channelType: 'whatsapp',
            });
          }
        } catch (err: unknown) {
          const text = err instanceof Error ? err.message : String(err);
          console.error('[WhatsApp Webhook] status update error:', text);
        }
      }

      for (const message of messages) {
        const from = typeof message.from === 'string' ? message.from : '';
        const messageId = typeof message.id === 'string' ? message.id : '';
        const parsed = parseInboundMessage(message);
        const text = parsed.text;
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

          // No single-org fallback - unresolved phone_number_id / WABA → skip (honest error log).
          const matched =
            (await lookupWhatsAppByPhone(inboundPhoneNumberId)) ||
            (await lookupWhatsAppByWaba(wabaId));

          if (!matched?.org_id) {
            console.error(
              '[WhatsApp Webhook] Cannot resolve org for phone_number_id=%s waba=%s - skipping message from %s (no cross-tenant guess)',
              inboundPhoneNumberId,
              wabaId,
              from
            );
            continue;
          }

          const ownerChannel =
            (await resolveChannelByMeta('owner_whatsapp', 'phone_number_id', inboundPhoneNumberId || '')) ||
            (await resolveChannelByMeta('owner_whatsapp', 'phoneNumberId', inboundPhoneNumberId || ''));
          if (ownerChannel) {
            console.warn('[WhatsApp Webhook] Owner number delivered here - skipping customer ingest');
            continue;
          }

          const orgId = matched.org_id;
          const webhookLimited = denyWebhookIfLimited(orgId);
          if (webhookLimited) {
            return webhookLimited;
          }
          const job = await ingestWhatsAppInbound({
            orgId,
            channelId: matched.id,
            channelMeta: (matched.meta || {}) as Record<string, unknown>,
            newChannelMeta: { whatsapp_business_account_id: wabaId, phone_number_id: inboundPhoneNumberId },
            from,
            messageId,
            text,
            media: parsed.media,
          });
          if (job) agentJobs.push(job);
        } catch (dbErr: unknown) {
          if (isRateLimitError(dbErr)) {
            return responseFromRateLimit(dbErr);
          }
          const errMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          // Column may not exist until 091_conversations_ai_paused is applied - retry without it once.
          if (errMsg.includes('ai_paused_until')) {
            console.warn(
              '[WhatsApp Webhook] ai_paused_until column missing - apply migration 091; processing without pause check'
            );
          }
          console.error('[WhatsApp Webhook] Processing error:', errMsg);
        }
      }
    }
  }

  for (const job of agentJobs) {
    fireInboundAgent(job);
  }

  return new NextResponse('OK', { status: 200 });
}
