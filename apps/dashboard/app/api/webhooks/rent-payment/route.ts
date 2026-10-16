import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { getOrgScopedClient, pool } from '@/lib/db';
import { assertWebhookBodySize } from '@/lib/webhook-crypto';
import { recordFailedWebhook } from '@/lib/failed-webhooks';
import { realtimeHub } from '@/lib/realtime-hub';

export const dynamic = 'force-dynamic';

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyStripeSig(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const piece of header.split(',')) {
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    const k = piece.slice(0, idx).trim();
    const v = piece.slice(idx + 1).trim();
    if (k === 't' || (k === 'v1' && !parts.v1)) parts[k] = v;
  }
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  return timingSafeEqualString(parts.v1, expected);
}

function verifyRazorpaySig(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualString(header, expected);
}

/**
 * POST /api/webhooks/rent-payment
 * Tenant rent PSP webhooks (Stripe Checkout / Razorpay Payment Link).
 * Distinct from SaaS billing webhooks. Requires signature.
 * Closes pm_charges only with verified psp_payment_id (close_gate).
 * Returns 200 after persist — never awaits an agent.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const size = assertWebhookBodySize(request, rawBody);
  if (!size.ok) {
    await recordFailedWebhook({
      channel: 'rent-payment',
      headers: request.headers,
      rawPayload: rawBody,
      errorMessage: size.error || 'body too large',
    });
    return NextResponse.json({ error: size.error }, { status: size.status });
  }

  const stripeSecret =
    process.env.RENT_STRIPE_WEBHOOK_SECRET?.trim() ||
    process.env.DAREX_STRIPE_WEBHOOK_SECRET?.trim() ||
    '';
  const razorSecret =
    process.env.RENT_RAZORPAY_WEBHOOK_SECRET?.trim() ||
    process.env.DAREX_RAZORPAY_WEBHOOK_SECRET?.trim() ||
    '';

  const stripeHeader = request.headers.get('stripe-signature');
  const razorHeader = request.headers.get('x-razorpay-signature');

  let provider: 'stripe' | 'razorpay' | null = null;
  if (stripeHeader && stripeSecret && verifyStripeSig(rawBody, stripeHeader, stripeSecret)) {
    provider = 'stripe';
  } else if (razorHeader && razorSecret && verifyRazorpaySig(rawBody, razorHeader, razorSecret)) {
    provider = 'razorpay';
  }

  if (!provider) {
    await recordFailedWebhook({
      channel: 'rent-payment',
      headers: request.headers,
      rawPayload: rawBody,
      errorMessage: 'Invalid or missing rent payment webhook signature',
    });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  let chargeId: string | null = null;
  let orgId: string | null = null;
  let paymentId: string | null = null;

  if (provider === 'stripe') {
    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (type !== 'checkout.session.completed' && type !== 'payment_intent.succeeded') {
      return NextResponse.json({ received: true, ignored: true });
    }
    const data = (parsed.data as { object?: Record<string, unknown> } | undefined)?.object || {};
    const meta = (data.metadata as Record<string, unknown> | undefined) || {};
    chargeId = typeof meta.chargeId === 'string' ? meta.chargeId : typeof meta.charge_id === 'string' ? meta.charge_id : null;
    orgId = typeof meta.orgId === 'string' ? meta.orgId : typeof meta.org_id === 'string' ? meta.org_id : null;
    paymentId =
      (typeof data.payment_intent === 'string' && data.payment_intent) ||
      (typeof data.id === 'string' && data.id) ||
      null;
  } else {
    const event = typeof parsed.event === 'string' ? parsed.event : '';
    if (!event.includes('payment') && !event.includes('captured')) {
      return NextResponse.json({ received: true, ignored: true });
    }
    const payload = (parsed.payload as Record<string, unknown> | undefined) || {};
    const payment = ((payload.payment as { entity?: Record<string, unknown> } | undefined)?.entity ||
      {}) as Record<string, unknown>;
    const notes = (payment.notes as Record<string, unknown> | undefined) || {};
    chargeId =
      (typeof notes.chargeId === 'string' && notes.chargeId) ||
      (typeof notes.charge_id === 'string' && notes.charge_id) ||
      null;
    orgId =
      (typeof notes.orgId === 'string' && notes.orgId) ||
      (typeof notes.org_id === 'string' && notes.org_id) ||
      null;
    paymentId = typeof payment.id === 'string' ? payment.id : null;
  }

  if (!chargeId || !orgId || !paymentId) {
    await recordFailedWebhook({
      channel: 'rent-payment',
      headers: request.headers,
      rawPayload: rawBody,
      errorMessage: 'Missing chargeId/orgId/paymentId metadata',
    });
    return NextResponse.json({ error: 'Missing metadata' }, { status: 400 });
  }

  // Resolve org exists (never trust body alone without signed metadata from PSP).
  const orgCheck = await pool.query(`SELECT id FROM orgs WHERE id = $1 AND status = 'active' LIMIT 1`, [
    orgId,
  ]);
  if (!orgCheck.rows[0]) {
    return NextResponse.json({ error: 'Unknown org' }, { status: 404 });
  }

  const { client } = await getOrgScopedClient(orgId);
  try {
    await client.query('BEGIN');
    const chargeRes = await client.query(
      `SELECT id, status FROM pm_charges WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [chargeId, orgId]
    );
    if (!chargeRes.rows[0]) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Charge not found' }, { status: 404 });
    }
    await client.query(
      `UPDATE pm_charges
          SET status = 'closed',
              psp_payment_id = $1,
              closed_reason = 'psp_webhook',
              closed_at = NOW(),
              updated_at = NOW()
        WHERE id = $2 AND org_id = $3`,
      [paymentId, chargeId, orgId]
    );
    await client.query('COMMIT');
    realtimeHub.publish(orgId, {
      type: 'rent_charge_paid',
      conversationId: undefined,
      message: chargeId,
      channelType: 'rent',
    });
  } catch (err: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rent-payment webhook]', message);
    await recordFailedWebhook({
      orgId,
      channel: 'rent-payment',
      headers: request.headers,
      rawPayload: rawBody,
      errorMessage: message,
    });
    return NextResponse.json({ error: 'Apply failed' }, { status: 500 });
  } finally {
    client.release();
  }

  return NextResponse.json({ received: true, closed: true, chargeId });
}
