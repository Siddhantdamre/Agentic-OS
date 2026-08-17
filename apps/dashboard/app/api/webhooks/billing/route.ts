import { NextResponse } from 'next/server';
import {
  assertBillingWebhookSignature,
  BillingSignatureError,
  claimWebhookEvent,
  detectWebhookProvider,
  finishWebhookEvent,
  processRazorpayEvent,
  processStripeEvent,
  type DetectedBillingProvider,
} from '@/app/api/billing/_lib';

export const dynamic = 'force-dynamic';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function razorpayEventId(parsed: Record<string, unknown>, headers: Headers): string | null {
  const headerId = headers.get('x-razorpay-event-id');
  if (headerId) return headerId;
  const event = asString(parsed.event);
  const payload = asRecord(parsed.payload);
  const subId = asString(asRecord(asRecord(payload.subscription).entity).id);
  const payId = asString(asRecord(asRecord(payload.payment).entity).id);
  const invoiceId = asString(asRecord(asRecord(payload.invoice).entity).id);
  const entityId = subId || payId || invoiceId;
  if (event && entityId) return `${event}:${entityId}`;
  return event;
}

async function applyEvent(
  provider: DetectedBillingProvider,
  parsed: Record<string, unknown>
): Promise<{ orgId: string | null; status: 'processed' | 'ignored' | 'error' | 'received' }> {
  switch (provider) {
    case 'stripe':
      return processStripeEvent(parsed);
    case 'razorpay':
      return processRazorpayEvent(parsed);
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return { orgId: null, status: 'ignored' };
    }
  }
}

/**
 * POST /api/webhooks/billing
 * Darex SaaS billing (Stripe / Razorpay). Signature required. Never awaits an LLM.
 * Unsigned → 401. DB apply only, then 200.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const provider = detectWebhookProvider(request.headers);
  if (!provider) {
    return NextResponse.json({ error: 'Unsigned billing webhook rejected' }, { status: 401 });
  }

  try {
    assertBillingWebhookSignature(provider, rawBody, request.headers);
  } catch (err) {
    if (err instanceof BillingSignatureError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Unsigned billing webhook rejected' }, { status: 401 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(rawBody) as unknown);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = provider === 'stripe' ? asString(parsed.type) : asString(parsed.event);
  const eventId = provider === 'stripe' ? asString(parsed.id) : razorpayEventId(parsed, request.headers);
  if (!eventId || !eventType) {
    return NextResponse.json({ error: 'Missing event id' }, { status: 400 });
  }

  const claimed = await claimWebhookEvent(provider, eventId, eventType);
  if (!claimed) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const result = await applyEvent(provider, parsed);
    await finishWebhookEvent(provider, eventId, result.orgId, result.status);
    return NextResponse.json({ received: true, status: result.status });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'webhook apply failed';
    console.error('[billing webhook] apply error:', message);
    await finishWebhookEvent(provider, eventId, null, 'error', message.slice(0, 500));
    return NextResponse.json({ received: true, status: 'error' });
  }
}
