import { NextResponse } from 'next/server';
import { WEBHOOK_SECRET_HEADER, parseEvolutionWebhook } from '@darex/whatsapp-gateway';
import { assertEvolutionWebhookSecret, assertWebhookBodySize } from '@/lib/webhook-crypto';
import { recordFailedWebhook, updateMessageDeliveryStatus } from '@/lib/failed-webhooks';
import { fireInboundAgent } from '@/lib/inbound-agent';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';
import { resolveChannelByMeta } from '@/lib/channel-normalize';
import { getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { ingestWhatsAppInbound } from '@/lib/whatsapp-inbound';
import { markWhatsAppQrConnected, markWhatsAppQrDisconnected } from '@/lib/whatsapp-evolution-channel';

const EVOLUTION_MAX_BODY_BYTES = Number(process.env.EVOLUTION_WEBHOOK_MAX_BODY_BYTES || 25 * 1024 * 1024);

/**
 * POST /api/webhooks/whatsapp-evolution
 * Inbound for QR-linked WhatsApp (Evolution API). Same contract as the Meta
 * webhook: persist fast, return 200, fire-and-forget the agent.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  // Media arrives inline as base64, so allow far more than the default 1 MB.
  const size = assertWebhookBodySize(req, rawBody, EVOLUTION_MAX_BODY_BYTES);
  if (!size.ok) {
    await recordFailedWebhook({
      channel: 'whatsapp',
      headers: req.headers,
      rawPayload: rawBody,
      errorMessage: size.error || 'body too large',
    });
    return new NextResponse(size.error || 'Payload Too Large', { status: size.status });
  }
  const auth = assertEvolutionWebhookSecret(req.headers.get(WEBHOOK_SECRET_HEADER));
  if (!auth.ok) {
    await recordFailedWebhook({
      channel: 'whatsapp',
      headers: req.headers,
      rawPayload: rawBody,
      errorMessage: auth.error || 'Unauthorized',
    });
    return new NextResponse(auth.error || 'Unauthorized', { status: auth.status });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    await recordFailedWebhook({
      channel: 'whatsapp',
      headers: req.headers,
      rawPayload: rawBody,
      errorMessage: 'Invalid JSON',
    });
    return new NextResponse('OK', { status: 200 });
  }

  const { instance, events } = parseEvolutionWebhook(body);
  if (!instance || events.length === 0) return new NextResponse('OK', { status: 200 });

  // Org comes from the instance we created for it, never from the payload.
  const channel = await resolveChannelByMeta('whatsapp', 'evolution_instance', instance);
  if (!channel?.org_id) {
    console.error('[WhatsApp Evolution Webhook] unknown instance %s - skipping (no cross-tenant guess)', instance);
    return new NextResponse('OK', { status: 200 });
  }
  const orgId = channel.org_id;

  const jobs: Array<Parameters<typeof fireInboundAgent>[0]> = [];
  for (const event of events) {
    try {
      if (event.kind === 'connection') {
        const { client } = await getOrgScopedClient(orgId);
        try {
          if (event.state === 'open') await markWhatsAppQrConnected(client, orgId, null, channel.id);
          else if (event.loggedOut) await markWhatsAppQrDisconnected(client, orgId, channel.id);
        } finally {
          client.release();
        }
      } else if (event.kind === 'status') {
        const updated = await updateMessageDeliveryStatus({
          orgId,
          providerMessageId: event.messageId,
          status: event.status,
        });
        if (updated) {
          realtimeHub.publish(orgId, {
            type: 'message_status_updated',
            conversationId: undefined,
            message: event.status,
            channelType: 'whatsapp',
          });
        }
      } else {
        const limited = denyWebhookIfLimited(orgId);
        if (limited) return limited;
        const job = await ingestWhatsAppInbound({
          orgId,
          channelId: channel.id,
          channelMeta: (channel.meta || {}) as Record<string, unknown>,
          newChannelMeta: (channel.meta || {}) as Record<string, unknown>,
          from: event.from,
          messageId: event.messageId,
          text: event.text,
          media: event.media ? { type: event.media.type, id: event.media.id, mimeType: event.media.mimeType, filename: event.media.filename, caption: event.media.caption, sha256: null } : null,
          mediaBase64: event.media?.base64 ?? null,
          senderName: event.pushName,
        });
        if (job) jobs.push(job);
      }
    } catch (err: unknown) {
      if (isRateLimitError(err)) return responseFromRateLimit(err);
      console.error('[WhatsApp Evolution Webhook] processing error:', err instanceof Error ? err.message : String(err));
    }
  }

  for (const job of jobs) fireInboundAgent(job);
  return new NextResponse('OK', { status: 200 });
}
