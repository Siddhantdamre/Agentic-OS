import { NextResponse } from 'next/server';
import { getOrgScopedClient, getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { appBaseUrl } from '@/lib/mail';
import {
  assertPortalReady,
  BillingConfigError,
  cancelProviderSubscription,
  CLIENT_ORG_ID_ERROR,
  createStripePortal,
  hasPaidSubscription,
  isBillingProvider,
  listSubscriptions,
  parseOrgPlanKey,
  recordBillingAudit,
  requestHasClientCustomerId,
  requestHasClientOrgId,
  requireBillingManager,
  upsertSubscription,
  type BillingProvider,
  type SubscriptionRow,
} from '../_lib';

export const dynamic = 'force-dynamic';

function pickManageTarget(
  subs: SubscriptionRow[],
  preferred: BillingProvider | null
): { provider: BillingProvider; row: SubscriptionRow } | null {
  if (preferred) {
    const row = subs.find((s) => s.provider === preferred);
    if (row) return { provider: preferred, row };
    return null;
  }
  const stripe = subs.find((s) => s.provider === 'stripe');
  const razorpay = subs.find((s) => s.provider === 'razorpay');
  if (hasPaidSubscription(stripe) && stripe) return { provider: 'stripe', row: stripe };
  if (hasPaidSubscription(razorpay) && razorpay) return { provider: 'razorpay', row: razorpay };
  if (stripe?.provider_customer_id) return { provider: 'stripe', row: stripe };
  if (razorpay?.provider_subscription_id) return { provider: 'razorpay', row: razorpay };
  return null;
}

/**
 * POST /api/billing/portal
 * - Stripe open: hosted customer portal URL
 * - Razorpay open: in-app manage payload (no hosted portal)
 * - action=cancel: cancel for the session org's provider subscription
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

    const actionRaw = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'open';
    const action =
      actionRaw === 'cancel' ? 'cancel' : actionRaw === 'manage' || actionRaw === 'open' ? 'open' : null;
    if (!action) {
      return NextResponse.json({ error: 'action must be open or cancel' }, { status: 400 });
    }

    const preferredProvider =
      body.provider != null && isBillingProvider(body.provider) ? body.provider : null;
    const atPeriodEnd = body.atPeriodEnd !== false && body.cancel_at_period_end !== false;

    const scoped = await getScopedClient({ allowSuspended: true });
    const { orgId, userId } = scoped;
    let target: { provider: BillingProvider; row: SubscriptionRow } | null = null;

    try {
      const gate = await requireBillingManager(scoped.client, userId);
      if ('error' in gate) {
        return NextResponse.json({ error: gate.error }, { status: gate.status });
      }
      const subs = await listSubscriptions(scoped.client, orgId);
      target = pickManageTarget(subs, preferredProvider);
    } finally {
      scoped.client.release();
    }

    if (!target) {
      return NextResponse.json(
        { error: 'No billing subscription for this organization' },
        { status: 404 }
      );
    }

    try {
      assertPortalReady(target.provider);
    } catch (cfg) {
      if (cfg instanceof BillingConfigError) {
        return NextResponse.json({ error: cfg.message, connected: false }, { status: 503 });
      }
      throw cfg;
    }

    if (action === 'cancel') {
      const subId = target.row.provider_subscription_id;
      if (!subId) {
        return NextResponse.json(
          { error: `No ${target.provider} subscription id for this organization` },
          { status: 404 }
        );
      }
      const canceled = await cancelProviderSubscription({
        provider: target.provider,
        subscriptionId: subId,
        atPeriodEnd,
      });

      const write = await getOrgScopedClient(orgId);
      try {
        await upsertSubscription(write.client, {
          orgId,
          provider: target.provider,
          planKey: parseOrgPlanKey(target.row.plan_key),
          status: canceled.cancelAtPeriodEnd
            ? target.row.status === 'trialing'
              ? 'trialing'
              : 'active'
            : 'canceled',
          seats: target.row.seats,
          customerId: target.row.provider_customer_id,
          subscriptionId: subId,
          periodStart: target.row.current_period_start
            ? new Date(target.row.current_period_start).toISOString()
            : null,
          periodEnd: target.row.current_period_end
            ? new Date(target.row.current_period_end).toISOString()
            : null,
          cancelAtPeriodEnd: canceled.cancelAtPeriodEnd,
        });
        await recordBillingAudit(write.client, {
          orgId,
          action: canceled.cancelAtPeriodEnd ? 'cancel_requested' : 'cancel_immediate',
          actorUserId: userId,
          provider: target.provider,
          planKey: target.row.plan_key,
          payload: { cancelAtPeriodEnd: canceled.cancelAtPeriodEnd },
        });
      } finally {
        write.client.release();
      }

      return NextResponse.json({
        provider: target.provider,
        action: 'cancel',
        cancelAtPeriodEnd: canceled.cancelAtPeriodEnd,
        status: canceled.status,
        neverEscrow: true,
      });
    }

    const writeOpen = await getOrgScopedClient(orgId);
    try {
      await recordBillingAudit(writeOpen.client, {
        orgId,
        action: 'portal_opened',
        actorUserId: userId,
        provider: target.provider,
        planKey: target.row.plan_key,
        payload: { mode: target.provider === 'razorpay' ? 'in_app' : 'hosted' },
      });
    } finally {
      writeOpen.client.release();
    }

    if (target.provider === 'razorpay') {
      return NextResponse.json({
        provider: 'razorpay',
        mode: 'in_app',
        neverEscrow: true,
        subscription: {
          plan: target.row.plan_key,
          status: target.row.status,
          seats: target.row.seats,
          cancelAtPeriodEnd: target.row.cancel_at_period_end,
          currentPeriodEnd: target.row.current_period_end,
        },
        actions: ['cancel', 'change_plan'],
        message:
          'Razorpay has no hosted customer portal. Use action=cancel or PATCH /api/billing/subscription.',
      });
    }

    const customerId = target.row.provider_customer_id;
    if (!customerId) {
      return NextResponse.json({ error: 'No Stripe customer for this organization' }, { status: 404 });
    }

    const origin = appBaseUrl(new URL(request.url).origin);
    const portal = await createStripePortal({
      customerId,
      returnUrl: `${origin}/billing`,
    });
    return NextResponse.json({
      url: portal.url,
      provider: 'stripe',
      mode: 'hosted',
      neverEscrow: true,
    });
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    if (error instanceof BillingConfigError) {
      return NextResponse.json({ error: error.message, connected: false }, { status: 503 });
    }
    console.error('API /api/billing/portal POST Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
