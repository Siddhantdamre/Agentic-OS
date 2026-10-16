import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';
import {
  BillingConfigError,
  canManageBilling,
  billingProviderGaps,
  catalogPlans,
  CLIENT_ORG_ID_ERROR,
  listBillingAudit,
  listInvoices,
  listSubscriptions,
  loadOrgPlan,
  providerConfigured,
  refreshOrgMeters,
  requestHasClientOrgId,
} from './_lib';
import { publicErrorMessage } from '@/lib/public-error';

export const dynamic = 'force-dynamic';

/**
 * GET /api/billing
 * Session org only — never a body/query org_id. Invoices are RLS-scoped + paginated.
 */
export async function GET(request: Request) {
  if (requestHasClientOrgId(request)) {
    return NextResponse.json({ error: CLIENT_ORG_ID_ERROR }, { status: 400 });
  }
  const url = new URL(request.url);
  const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10);
  const offsetRaw = parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
  const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;

  let orgId = '';
  try {
    const scoped = await getScopedClient({ allowSuspended: true });
    orgId = scoped.orgId;
    let role;
    let plan;
    let subscriptions;
    let invoicePage;
    let audit;
    let canManage = false;
    try {
      role = await loadHumanRole(scoped.client, scoped.userId);
      canManage = canManageBilling(role);
      plan = await loadOrgPlan(scoped.client, orgId);
      subscriptions = await listSubscriptions(scoped.client, orgId);
      // Invoices, PSP ids and the billing audit trail are for billing managers only.
      invoicePage = canManage
        ? await listInvoices(scoped.client, orgId, { limit, offset })
        : { invoices: [], total: 0, limit, offset };
      audit = canManage ? await listBillingAudit(scoped.client, orgId, { limit: 25 }) : [];
    } finally {
      scoped.client.release();
    }

    const meters = await refreshOrgMeters(orgId);
    const dunning = subscriptions
      .filter((s) => s.status === 'past_due' || s.status === 'unpaid')
      .map((s) => ({
        provider: s.provider,
        status: s.status,
        graceEndsAt: s.dunning_grace_ends_at ?? null,
      }));

    return NextResponse.json({
      orgId,
      role,
      canManageBilling: canManage,
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
        customerId: canManage ? s.provider_customer_id : null,
        subscriptionId: canManage ? s.provider_subscription_id : null,
        currentPeriodEnd: s.current_period_end,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        dunningGraceEndsAt: s.dunning_grace_ends_at ?? null,
      })),
      invoices: invoicePage.invoices.map((i) => ({
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
      invoicePagination: {
        total: invoicePage.total,
        limit: invoicePage.limit,
        offset: invoicePage.offset,
        hasMore: invoicePage.offset + invoicePage.invoices.length < invoicePage.total,
      },
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        provider: a.provider,
        plan: a.plan_key,
        payload: a.payload,
        createdAt: a.created_at,
        actorUserId: a.actor_user_id,
      })),
      dunning,
      meters: meters.meters,
      llm: meters.llm,
      llmError: meters.llmError,
      confirmReject: meters.confirmReject,
      usageBlocked: meters.usageBlocked,
      seatsUsed: meters.seatsUsed,
      whatsappConversations: meters.whatsappConversations,
    });
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    if (error instanceof BillingConfigError) {
      return NextResponse.json({ error: publicErrorMessage(error) }, { status: 503 });
    }
    console.error('API /api/billing GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
