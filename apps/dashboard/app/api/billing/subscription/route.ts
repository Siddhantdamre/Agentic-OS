import { NextResponse } from 'next/server';
import { getOrgScopedClient, getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import {
  assertCheckoutReady,
  BillingConfigError,
  changeProviderPlan,
  CLIENT_ORG_ID_ERROR,
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
  type BillingProvider,
} from '../_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { publicErrorMessage } from '@/lib/public-error';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/billing/subscription
 * Modify-in-place plan change for the session org.
 * Stripe: subscriptions.update with proration_behavior=create_prorations.
 * Razorpay: subscriptions PATCH schedule_change_at=now (provider has no Stripe-style proration).
 * Never trusts client-sent prices, customer ids, or org_id.
 */
export async function PATCH(request: Request) {
  try {
    const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
    if (requestHasClientOrgId(request, body)) {
      return NextResponse.json({ error: CLIENT_ORG_ID_ERROR }, { status: 400 });
    }
    if (requestHasClientCustomerId(body)) {
      return NextResponse.json(
        {
          error:
            'customer_id / subscription_id are not accepted from the client; they are resolved from the session org.',
        },
        { status: 400 }
      );
    }

    const plan = body.plan;
    if (!isCheckoutPlan(plan)) {
      return NextResponse.json({ error: 'plan must be starter, growth, or enterprise' }, { status: 400 });
    }
    const seatsRaw = body.seats;
    const seats =
      typeof seatsRaw === 'number' && Number.isFinite(seatsRaw) ? Math.trunc(seatsRaw) : undefined;
    if (seats != null && (seats < 1 || seats > seatMax())) {
      return NextResponse.json({ error: `seats must be between 1 and ${seatMax()}` }, { status: 400 });
    }

    const preferredProvider =
      body.provider != null && isBillingProvider(body.provider) ? body.provider : null;

    const scoped = await getScopedClient({ allowSuspended: true });
    const { orgId, userId } = scoped;
    let provider: BillingProvider | null = null;
    let subscriptionId: string | null = null;
    let currentSeats = 1;
    let customerId: string | null = null;

    try {
      const gate = await requireBillingManager(scoped.client, userId);
      if ('error' in gate) {
        return NextResponse.json({ error: gate.error }, { status: gate.status });
      }
      const subs = await listSubscriptions(scoped.client, orgId);
      const row = preferredProvider
        ? subs.find((s) => s.provider === preferredProvider)
        : subs.find((s) => hasPaidSubscription(s)) ?? subs[0];
      if (!row || !hasPaidSubscription(row)) {
        return NextResponse.json(
          { error: 'No active subscription to modify. Use checkout to start a plan.' },
          { status: 404 }
        );
      }
      if (!row.provider_subscription_id) {
        return NextResponse.json(
          { error: 'Subscription is missing provider id; cannot change plan in place.' },
          { status: 409 }
        );
      }
      provider = row.provider;
      subscriptionId = row.provider_subscription_id;
      currentSeats = row.seats;
      customerId = row.provider_customer_id;
    } finally {
      scoped.client.release();
    }

    if (!provider || !subscriptionId) {
      return NextResponse.json({ error: 'No active subscription to modify' }, { status: 404 });
    }

    try {
      assertCheckoutReady(provider, plan);
    } catch (cfg) {
      if (cfg instanceof BillingConfigError) {
        return NextResponse.json({ error: cfg.message, connected: false }, { status: 503 });
      }
      throw cfg;
    }

    const nextSeats = seats ?? currentSeats;
    const changed = await changeProviderPlan({
      provider,
      subscriptionId,
      plan,
      seats: nextSeats,
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
        subscriptionId,
        cancelAtPeriodEnd: false,
      });
      await recordBillingAudit(write.client, {
        orgId,
        action: 'plan_changed',
        actorUserId: userId,
        provider,
        planKey: plan,
        payload: { seats: changed.seats, prorated: changed.prorated, via: 'subscription_patch' },
      });
    } finally {
      write.client.release();
    }

    return NextResponse.json({
      provider,
      plan: changed.plan,
      seats: changed.seats,
      status: changed.status,
      prorated: changed.prorated,
      neverEscrow: true,
    });
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    if (error instanceof BillingConfigError) {
      return NextResponse.json({ error: publicErrorMessage(error), connected: false }, { status: 503 });
    }
    console.error('API /api/billing/subscription PATCH Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
