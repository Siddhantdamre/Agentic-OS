import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';
import {
  BillingConfigError,
  billingProviderGaps,
  catalogPlans,
  CLIENT_ORG_ID_ERROR,
  listInvoices,
  listSubscriptions,
  loadOrgPlan,
  providerConfigured,
  refreshOrgMeters,
  requestHasClientOrgId,
} from './_lib';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing
 * Session org only — never a body/query org_id. Invoices are RLS-scoped.
 */
export async function GET(request: Request) {
  if (requestHasClientOrgId(request)) {
    return NextResponse.json({ error: CLIENT_ORG_ID_ERROR }, { status: 400 });
  }
  let orgId = '';
  try {
    const scoped = await getScopedClient();
    orgId = scoped.orgId;
    let role;
    let plan;
    let subscriptions;
    let invoices;
    try {
      role = await loadHumanRole(scoped.client, scoped.userId);
      plan = await loadOrgPlan(scoped.client, orgId);
      subscriptions = await listSubscriptions(scoped.client, orgId);
      invoices = await listInvoices(scoped.client, orgId);
    } finally {
      scoped.client.release();
    }

    const meters = await refreshOrgMeters(orgId);
    return NextResponse.json({
      orgId,
      role,
      plan,
      neverEscrow: true,
      providers: {
        stripe: providerConfigured('stripe'),
        razorpay: providerConfigured('razorpay'),
      },
      providerGaps: billingProviderGaps(),
      catalog: catalogPlans(),
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        provider: s.provider,
        plan: s.plan_key,
        status: s.status,
        seats: s.seats,
        customerId: s.provider_customer_id,
        subscriptionId: s.provider_subscription_id,
        currentPeriodEnd: s.current_period_end,
        cancelAtPeriodEnd: s.cancel_at_period_end,
      })),
      invoices: invoices.map((i) => ({
        id: i.id,
        orgId: i.org_id,
        provider: i.provider,
        amountMinor: i.amount_cents,
        currency: i.currency,
        status: i.status,
        hostedUrl: i.hosted_invoice_url,
        createdAt: i.created_at,
        failedAt: i.failed_at,
      })),
      meters: meters.meters,
      llm: meters.llm,
      llmError: meters.llmError,
      confirmReject: meters.confirmReject,
      usageBlocked: meters.usageBlocked,
      seatsUsed: meters.seatsUsed,
      whatsappConversations: meters.whatsappConversations,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof BillingConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error('API /api/billing GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
