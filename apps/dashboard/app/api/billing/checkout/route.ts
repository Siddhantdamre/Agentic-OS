import { NextResponse } from 'next/server';
import { otherLiveProvider } from '../_plan-resolve';
import { getOrgScopedClient, getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { lookupUserById } from '@/lib/auth-user';
import { appBaseUrl } from '@/lib/mail';
import {
  assertCheckoutReady,
  BillingConfigError,
  changeProviderPlan,
  CLIENT_ORG_ID_ERROR,
  createRazorpaySubscription,
  createStripeCheckout,
  hasPaidSubscription,
  isBillingProvider,
  isCheckoutPlan,
  listSubscriptions,
  recordBillingAudit,
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
 * If the org already has an active subscription for the provider, modify in place
 * (Stripe with proration) instead of opening a second parallel checkout.
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

    const scoped = await getScopedClient({ allowSuspended: true });
    const { orgId, userId } = scoped;
    let customerId: string | null = null;
    let email: string | undefined;
    let existingSubId: string | null = null;
    let existingIsPaid = false;
    try {
      const gate = await requireBillingManager(scoped.client, userId);
      if ('error' in gate) {
        return NextResponse.json({ error: gate.error }, { status: gate.status });
      }
      const existing = await listSubscriptions(scoped.client, orgId);
      // One live subscription per org: never open a second on another provider.
      const other = otherLiveProvider(existing, provider);
      if (other) {
        return NextResponse.json(
          {
            error: `This workspace already has a ${other.status} ${other.provider} subscription. Change or cancel it there before subscribing via ${provider}.`,
            code: 'SUBSCRIPTION_EXISTS_ON_OTHER_PROVIDER',
            provider: other.provider,
          },
          { status: 409 }
        );
      }
      const row = existing.find((s) => s.provider === provider);
      customerId = row?.provider_customer_id ?? null;
      existingSubId = row?.provider_subscription_id ?? null;
      existingIsPaid = hasPaidSubscription(row);
      const user = await lookupUserById(scoped.client, userId);
      email = user?.email;
    } finally {
      scoped.client.release();
    }

    // Active paid subscription → modify in place (no second parallel checkout).
    if (existingIsPaid && existingSubId) {
      const changed = await changeProviderPlan({
        provider,
        subscriptionId: existingSubId,
        plan,
        seats,
        orgId,
      });
      const write = await getOrgScopedClient(orgId);
      try {
        await upsertSubscription(write.client, {
          orgId,
          provider,
          planKey: plan,
          status: 'active',
          seats: changed.seats,
          customerId,
          subscriptionId: existingSubId,
          cancelAtPeriodEnd: false,
        });
        await recordBillingAudit(write.client, {
          orgId,
          action: 'plan_changed',
          actorUserId: userId,
          provider,
          planKey: plan,
          payload: { seats: changed.seats, prorated: changed.prorated, via: 'checkout' },
        });
      } finally {
        write.client.release();
      }
      return NextResponse.json({
        changed: true,
        provider,
        plan: changed.plan,
        seats: changed.seats,
        prorated: changed.prorated,
        neverEscrow: true,
      });
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
      await recordBillingAudit(write.client, {
        orgId,
        action: 'checkout_started',
        actorUserId: userId,
        provider,
        planKey: plan,
        payload: { seats },
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
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    if (error instanceof BillingConfigError) {
      return NextResponse.json({ error: error.message, connected: false }, { status: 503 });
    }
    console.error('API /api/billing/checkout POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
