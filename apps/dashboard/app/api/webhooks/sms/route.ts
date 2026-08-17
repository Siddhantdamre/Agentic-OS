import { NextResponse } from 'next/server';
import { fireInboundAgent } from '@/lib/inbound-agent';
import { assertTwilioWebhookSignature, parseFormBody } from '@/lib/webhook-crypto';
import {
  inboundJobFromPersist,
  persistInboundMessage,
  resolveChannelByMeta,
  resolveSingleOrgChannel,
} from '@/lib/channel-normalize';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';

/**
 * POST /api/webhooks/sms
 * Twilio (or compatible) inbound SMS. Signature required. Persist → 200 → WorkItemWorkflow.
 * Org from SMS/Twilio channel config (To number), never body org_id.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = assertTwilioWebhookSignature(rawBody, req.headers.get('x-twilio-signature'), req.url);
  if (!sig.ok) {
    return new NextResponse(sig.error || 'Unauthorized', { status: sig.status });
  }

  const params = parseFormBody(rawBody);
  void params.org_id;
  void params.orgId;

  const from = (params.From || params.from || '').trim();
  const to = (params.To || params.to || '').trim();
  const body = (params.Body || params.body || params.Text || '').trim() || '[sms message]';
  const messageSid = (params.MessageSid || params.SmsSid || params.SmsMessageSid || '').trim();

  if (!from) {
    return new NextResponse('OK', { status: 200 });
  }

  try {
    const matched =
      (await resolveChannelByMeta('sms', 'phone', to)) ||
      (await resolveChannelByMeta('sms', 'from_number', to)) ||
      (await resolveChannelByMeta('twilio', 'phone', to)) ||
      (await resolveChannelByMeta('twilio', 'from_number', to)) ||
      (await resolveChannelByMeta('sms', 'phone', process.env.TWILIO_FROM_NUMBER || '')) ||
      (await resolveChannelByMeta('twilio', 'from_number', process.env.TWILIO_FROM_NUMBER || '')) ||
      (await resolveSingleOrgChannel('sms')) ||
      (await resolveSingleOrgChannel('twilio'));

    if (!matched?.org_id) {
      console.error('[SMS Webhook] Cannot resolve org for To', to);
      return new NextResponse('OK', { status: 200 });
    }

    const webhookLimited = denyWebhookIfLimited(matched.org_id);
    if (webhookLimited) return webhookLimited;

      const persisted = await persistInboundMessage({
        orgId: matched.org_id,
        channelKey: 'sms',
        channelType: 'sms',
        contactId: from,
        content: body,
        providerMessageId: messageSid || null,
        extraMeta: { to, phone: to, from_number: to },
      });

    if (persisted.shouldFireAgent) {
      fireInboundAgent(
        inboundJobFromPersist(
          matched.org_id,
          {
            orgId: matched.org_id,
            channelKey: 'sms',
            channelType: 'sms',
            contactId: from,
            content: body,
            providerMessageId: messageSid || null,
          },
          persisted
        )
      );
    }
  } catch (err: unknown) {
    if (isRateLimitError(err)) return responseFromRateLimit(err);
    const text = err instanceof Error ? err.message : String(err);
    console.error('[SMS Webhook] Processing error:', text);
  }

  return new NextResponse('OK', { status: 200 });
}
