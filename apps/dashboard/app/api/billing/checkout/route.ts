import { NextResponse } from 'next/server';
import { getOrgScopedClient, getScopedClient } from '@/lib/db';
import { lookupUserById } from '@/lib/auth-user';
import { appBaseUrl } from '@/lib/mail';
import {
  assertCheckoutReady,
  BillingConfigError,
  CLIENT_ORG_ID_ERROR,
  createRazorpaySubscription,
  createStripeCheckout,
  isBillingProvider,
  isCheckoutPlan,
  listSubscriptions,
  requestHasClientCustomerId,
  requestHasClientOrgId,
  requireBillingManager,
  seatMax,
  upsertSubscription,
} from '../_lib';

export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/checkout
 * Start Darex SaaS checkout (Stripe and/or Razorpay). Org is session-only.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (requestHasClientOrgId(request, body)) {
      return NextResponse.json({ error: CLIENT_ORG_ID_ERROR }, { status: 400 });
    }
    if (requestHasClientCustomerId(body)) {
      return NextResponse.json(
        { error: 'customer_id / subscription_id are not accepted from the client; they are resolved from the session org.' },
        { status: 400 }
      );
    }

    const provider = body.provider;
    const plan = body.plan;
    const seatsRaw = body.seats;
    if (!isBillingProvider(provider)) {
      return NextResponse.json({ error: 'provider must be stripe or razorpay' }, { status: 400 });
    }
    if (!isCheckoutPlan(plan)) {
      return NextResponse.json({ error: 'plan must be starter, growth, or enterprise' }, { status: 400 });
    }
    const seats = typeof seatsRaw === 'number' && Number.isFinite(seatsRaw) ? Math.trunc(seatsRaw) : 1;
    if (seats < 1 || seats > seatMax()) {
      return NextResponse.json({ error: `seats must be between 1 and ${seatMax()}` }, { status: 400 });
    }
    try {
      assertCheckoutReady(provider, plan);
    } catch (cfg) {
      if (cfg instanceof BillingConfigError) {
        return NextResponse.json({ error: cfg.message, connected: false }, { status: 503 });
      }
      throw cfg;
    }

    const scoped = await getScopedClient();
    const { orgId, userId } = scoped;
    let customerId: string | null = null;
    let email: string | undefined;
    try {
      const gate = await requireBillingManager(scoped.client, userId);
      if ('error' in gate) {
        return NextResponse.json({ error: gate.error }, { status: gate.status });
      }
      const existing = await listSubscriptions(scoped.client, orgId);
      const row = existing.find((s) => s.provider === provider);
      customerId = row?.provider_customer_id ?? null;
      const user = await lookupUserById(scoped.client, userId);
      email = user?.email;
    } finally {
      scoped.client.release();
    }

    const origin = appBaseUrl(new URL(request.url).origin);
    const successUrl = `${origin}/billing?checkout=success`;
    const cancelUrl = `${origin}/billing?checkout=cancel`;

    let checkoutUrl: string;
    let subscriptionId: string | null = null;
    let resolvedCustomer = customerId;

    switch (provider) {
      case 'stripe': {
        const session = await createStripeCheckout({
          orgId,
          plan,
          seats,
          customerId,
          successUrl,
          cancelUrl,
        });
        checkoutUrl = session.url;
        resolvedCustomer = session.customerId;
        break;
      }
      case 'razorpay': {
        const sub = await createRazorpaySubscription({
          orgId,
          plan,
          seats,
          customerId,
          email,
        });
        checkoutUrl = sub.shortUrl;
        resolvedCustomer = sub.customerId;
        subscriptionId = sub.subscriptionId;
        break;
      }
      default: {
        const _exhaustive: never = provider;
        return NextResponse.json({ error: `Unhandled provider ${String(_exhaustive)}` }, { status: 400 });
      }
    }

    const write = await getOrgScopedClient(orgId);
    try {
      await upsertSubscription(write.client, {
        orgId,
        provider,
        planKey: plan,
        status: 'incomplete',
        seats,
        customerId: resolvedCustomer,
        subscriptionId,
      });
    } finally {
      write.client.release();
    }

    return NextResponse.json({
      url: checkoutUrl,
      provider,
      plan,
      seats,
      neverEscrow: true,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof BillingConfigError) {
      return NextResponse.json({ error: error.message, connected: false }, { status: 503 });
    }
    console.error('API /api/billing/checkout POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
