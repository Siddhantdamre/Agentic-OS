import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { appBaseUrl } from '@/lib/mail';
import {
  assertPortalReady,
  BillingConfigError,
  CLIENT_ORG_ID_ERROR,
  createStripePortal,
  listSubscriptions,
  requestHasClientCustomerId,
  requestHasClientOrgId,
  requireBillingManager,
} from '../_lib';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/portal
 * Stripe customer portal for the session org. Razorpay has no hosted portal.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (requestHasClientOrgId(request, body)) {
      return NextResponse.json({ error: CLIENT_ORG_ID_ERROR }, { status: 400 });
    }
    if (requestHasClientCustomerId(body)) {
      return NextResponse.json(
        { error: 'customer_id is not accepted from the client; it is resolved from the session org.' },
        { status: 400 }
      );
    }

    const scoped = await getScopedClient();
    const { orgId, userId } = scoped;
    let customerId: string | null = null;
    try {
      const gate = await requireBillingManager(scoped.client, userId);
      if ('error' in gate) {
        return NextResponse.json({ error: gate.error }, { status: gate.status });
      }
      try {
        assertPortalReady();
      } catch (cfg) {
        if (cfg instanceof BillingConfigError) {
          return NextResponse.json({ error: cfg.message, connected: false }, { status: 503 });
        }
        throw cfg;
      }
      const subs = await listSubscriptions(scoped.client, orgId);
      customerId = subs.find((s) => s.provider === 'stripe')?.provider_customer_id ?? null;
    } finally {
      scoped.client.release();
    }

    if (!customerId) {
      return NextResponse.json({ error: 'No Stripe customer for this organization' }, { status: 404 });
    }

    const origin = appBaseUrl(new URL(request.url).origin);
    const portal = await createStripePortal({
      customerId,
      returnUrl: `${origin}/billing`,
    });
    return NextResponse.json({ url: portal.url, neverEscrow: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof BillingConfigError) {
      return NextResponse.json({ error: error.message, connected: false }, { status: 503 });
    }
    console.error('API /api/billing/portal POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
