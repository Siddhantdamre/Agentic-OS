import { NextResponse } from 'next/server';
import { fireInboundAgent } from '@/lib/inbound-agent';
import { assertMetaWebhookSignature } from '@/lib/webhook-crypto';
import {
  inboundJobFromPersist,
  persistInboundMessage,
  resolveChannelByMeta,
  resolveSingleOrgChannel,
} from '@/lib/channel-normalize';
import { denyWebhookIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';

/**
 * GET /api/webhooks/instagram
 * Meta webhook verification. Same app secret as WhatsApp (X-Hub-Signature-256).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const verifyToken = process.env.VERIFY_TOKEN || process.env.INSTAGRAM_VERIFY_TOKEN;

    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      return new NextResponse(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new NextResponse('Forbidden', { status: 403 });
  } catch (error) {
    console.error('[Instagram Webhook] GET error:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}

type IgMessage = {
  from: string;
  id: string;
  text: string;
  igUserId: string | null;
};

function collectInstagramMessages(body: Record<string, unknown>): IgMessage[] {
  const out: IgMessage[] = [];
  const entries = (body.entry as unknown[]) || [];
  for (const entry of entries) {
    const rec = (entry || {}) as Record<string, unknown>;
    const igUserId =
      (typeof rec.id === 'string' && rec.id) ||
      null;

    const messaging = (rec.messaging as Record<string, unknown>[]) || [];
    for (const item of messaging) {
      const sender = (item.sender as Record<string, unknown> | undefined) || {};
      const message = (item.message as Record<string, unknown> | undefined) || {};
      const from = typeof sender.id === 'string' ? sender.id : '';
      if (!from) continue;
      const text =
        (typeof message.text === 'string' && message.text) ||
        (typeof item.text === 'string' && item.text) ||
        '[instagram message]';
      const id = typeof message.mid === 'string' ? message.mid : typeof item.mid === 'string' ? item.mid : '';
      out.push({ from, id, text, igUserId });
    }

    const changes = (rec.changes as unknown[]) || [];
    for (const change of changes) {
      const value = ((change as { value?: Record<string, unknown> })?.value) || {};
      const messages = (value.messages as Record<string, unknown>[]) || [];
      const metadata = (value.metadata as Record<string, unknown>) || {};
      const pageId =
        (typeof metadata.instagram_account_id === 'string' && metadata.instagram_account_id) ||
        igUserId;
      for (const message of messages) {
        const from = typeof message.from === 'string' ? message.from : '';
        if (!from) continue;
        const textObj = message.text as { body?: string } | undefined;
        const text =
          (typeof textObj?.body === 'string' && textObj.body) ||
          (typeof message.text === 'string' && message.text) ||
          '[instagram message]';
        const id = typeof message.id === 'string' ? message.id : '';
        out.push({ from, id, text, igUserId: pageId });
      }
    }
  }
  return out;
}

/**
 * POST /api/webhooks/instagram
 * Persist → 200 → WorkItemWorkflow. Org from Instagram channel config.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = assertMetaWebhookSignature(rawBody, req.headers.get('x-hub-signature-256'));
  if (!sig.ok) {
    return new NextResponse(sig.error || 'Unauthorized', { status: sig.status });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new NextResponse('OK', { status: 200 });
  }

  const objectName = typeof body.object === 'string' ? body.object : '';
  if (objectName && objectName !== 'instagram' && objectName !== 'page') {
    return new NextResponse('OK', { status: 200 });
  }

  const agentJobs: Array<Parameters<typeof fireInboundAgent>[0]> = [];
  const messages = collectInstagramMessages(body);

  for (const message of messages) {
    try {
      const matched =
        (await resolveChannelByMeta('instagram', 'ig_user_id', message.igUserId)) ||
        (await resolveChannelByMeta('instagram', 'instagram_account_id', message.igUserId)) ||
        (await resolveChannelByMeta('instagram', 'page_id', message.igUserId)) ||
        (await resolveSingleOrgChannel('instagram'));

      if (!matched?.org_id) {
        console.error('[Instagram Webhook] Cannot resolve org for ig user', message.igUserId);
        continue;
      }

      const webhookLimited = denyWebhookIfLimited(matched.org_id);
      if (webhookLimited) return webhookLimited;

      const persisted = await persistInboundMessage({
        orgId: matched.org_id,
        channelKey: 'instagram',
        channelType: 'instagram',
        contactId: message.from,
        content: message.text,
        providerMessageId: message.id || null,
        extraMeta: { ig_user_id: message.igUserId },
      });
      if (persisted.shouldFireAgent) {
        agentJobs.push(inboundJobFromPersist(matched.org_id, {
          orgId: matched.org_id,
          channelKey: 'instagram',
          channelType: 'instagram',
          contactId: message.from,
          content: message.text,
          providerMessageId: message.id || null,
        }, persisted));
      }
    } catch (err: unknown) {
      if (isRateLimitError(err)) return responseFromRateLimit(err);
      const text = err instanceof Error ? err.message : String(err);
      console.error('[Instagram Webhook] Processing error:', text);
    }
  }

  for (const job of agentJobs) {
    fireInboundAgent(job);
  }
  return new NextResponse('OK', { status: 200 });
}
