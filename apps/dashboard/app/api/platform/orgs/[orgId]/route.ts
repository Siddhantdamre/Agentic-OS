import { NextResponse } from 'next/server';
import {
  paymentMethodLink,
  redactPayloadPreview,
  requirePlatformAdmin,
} from '@/lib/platform-admin';
import {
  isPlatformSchemaMissing,
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';
import {
  fetchOrgWeeklyCost,
  LangfuseUnavailableError,
} from '@/lib/org-cost';
import { LangfuseConfigError, resolveLangfuseConfig } from '@/lib/langfuse-trace';
import { loadRuntimeControls } from '@/lib/employee-metrics-query';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string }> };

/**
 * GET /api/platform/orgs/:orgId — drill-in (audited read).
 * Payment method is a processor dashboard link only — never card data.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;

    const { orgId } = await context.params;
    if (!orgId) {
      return NextResponse.json({ error: 'orgId required' }, { status: 400 });
    }

    const detail = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'org.read',
        targetOrgId: orgId,
        targetTable: 'orgs',
        targetRowId: orgId,
        reason: 'directory',
      },
      async (client) => {
        const orgRes = await client.query(
          `SELECT id, name, slug, status, plan, suspended_at, suspended_by,
                  deletion_requested_at, created_at, updated_at
             FROM orgs WHERE id = $1 LIMIT 1`,
          [orgId]
        );
        const org = orgRes.rows[0];
        if (!org) {
          return null;
        }

        let supportAccessEnabled: boolean | null = null;
        try {
          const sa = await client.query<{ support_access_enabled: boolean }>(
            `SELECT support_access_enabled FROM orgs WHERE id = $1`,
            [orgId]
          );
          supportAccessEnabled = Boolean(sa.rows[0]?.support_access_enabled);
        } catch (err) {
          // Migration 121 adds support_access_enabled — tolerate missing column
          // until migrate runs (Postgres currently down).
          if (!isPlatformSchemaMissing(err)) throw err;
          supportAccessEnabled = null;
        }

        const membersRes = await client.query(
          `SELECT
             om.user_id,
             om.role,
             u.email,
             COALESCE(u.session_epoch, 0) AS session_epoch,
             (u.disabled_at IS NOT NULL) AS disabled,
             login.last_login_at
           FROM organization_memberships om
           JOIN users u ON u.id = om.user_id
           LEFT JOIN LATERAL (
             SELECT MAX(created_at) AS last_login_at
               FROM audit_events ae
              WHERE ae.org_id = om.org_id
                AND ae.actor_user_id = om.user_id
                AND ae.kind = 'login'
           ) login ON true
           WHERE om.org_id = $1
           ORDER BY om.role, u.email`,
          [orgId]
        );

        const metersRes = await client.query(
          `SELECT meter_kind, quantity, soft_limit, hard_limit, unit, source,
                  period_start, period_end, truncated, updated_at
             FROM billing_meters
            WHERE org_id = $1
              AND period_end >= CURRENT_DATE
            ORDER BY meter_kind`,
          [orgId]
        );

        const failedRes = await client.query<{
          org_count: string;
          unresolved_null: string;
        }>(
          `SELECT
             COUNT(*) FILTER (WHERE org_id = $1)::text AS org_count,
             COUNT(*) FILTER (WHERE org_id IS NULL)::text AS unresolved_null
             FROM failed_webhooks`,
          [orgId]
        );

        const auditRes = await client.query(
          `SELECT
             id, kind, actor_type, actor_user_id, actor_employee_id, actor_component,
             work_item_id, plan_id, tool, action, risk_class, model,
             langfuse_trace_id, result_status, data_classes,
             SUBSTRING(COALESCE(payload::text, '') FROM 1 FOR 400) AS payload_preview,
             created_at
           FROM audit_events
           WHERE org_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 50`,
          [orgId]
        );

        const adminAuditRes = await client.query(
          `SELECT id, actor_user_id, platform_role, action, target_table,
                  target_row_id, reason, created_at
             FROM admin_audit_log
            WHERE target_org_id = $1
            ORDER BY created_at DESC
            LIMIT 50`,
          [orgId]
        );

        const subRes = await client.query(
          `SELECT id, provider, provider_customer_id, provider_subscription_id,
                  plan_key, status, seats, cancel_at_period_end,
                  dunning_grace_ends_at, current_period_start, current_period_end
             FROM billing_subscriptions
            WHERE org_id = $1
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1`,
          [orgId]
        );
        const sub = subRes.rows[0] || null;

        const invoicesRes = await client.query(
          `SELECT id, status, amount_cents, currency, period_start, period_end,
                  paid_at, failed_at, created_at
             FROM billing_invoices
            WHERE org_id = $1
            ORDER BY created_at DESC
            LIMIT 10`,
          [orgId]
        );

        let overridesRaw: {
          seat_cap: number | null;
          meter_caps: Record<string, { soft?: number | null; hard?: number | null }> | null;
          feature_flags: Record<string, boolean> | null;
        } | null = null;
        try {
          const ov = await client.query<{
            seat_cap: number | null;
            meter_caps: Record<string, { soft?: number | null; hard?: number | null }> | null;
            feature_flags: Record<string, boolean> | null;
          }>(
            `SELECT seat_cap, meter_caps, feature_flags, reason, updated_by, updated_at
               FROM org_plan_overrides WHERE org_id = $1`,
            [orgId]
          );
          overridesRaw = ov.rows[0] || null;
        } catch (err) {
          if (!isPlatformSchemaMissing(err)) throw err;
        }

        const connectorsRes = await client.query<{
          id: string;
          connector_key: string;
          status: string;
          nango_connection_id: string | null;
        }>(
          `SELECT id::text AS id, connector_key, status, nango_connection_id
             FROM org_connectors
            WHERE org_id = $1
            ORDER BY connector_key`,
          [orgId]
        );

        let killSwitch: boolean | null = null;
        let rolloutStage: number | null = null;
        try {
          const controls = await loadRuntimeControls(client, orgId);
          killSwitch = controls.killSwitch;
          rolloutStage = controls.rolloutStage;
        } catch {
          killSwitch = null;
          rolloutStage = null;
        }

        const invoices = invoicesRes.rows.map((inv) => ({
          id: inv.id,
          status: inv.status as string | null,
          amountMinor: inv.amount_cents != null ? Number(inv.amount_cents) : null,
          currency: inv.currency as string | null,
          createdAt: inv.created_at as string | Date | null,
        }));

        // Flat shape matching the admin drill-in UI (PlatformOrgDetail).
        return {
          id: org.id as string,
          name: org.name as string,
          slug: org.slug as string | null,
          status: org.status as string,
          plan: org.plan as string | null,
          suspendedBy: org.suspended_by as string | null,
          suspendedAt: org.suspended_at as string | Date | null,
          supportAccessEnabled,
          killSwitch,
          rolloutStage,
          platformRole: admin.platformRole,
          members: membersRes.rows.map((m) => ({
            userId: m.user_id as string,
            role: m.role as string | null,
            email: m.email as string | null,
            sessionEpoch: Number(m.session_epoch) || 0,
            disabled: m.disabled === true,
            lastLoginAt: m.last_login_at as string | Date | null,
          })),
          meters: metersRes.rows.map((m) => ({
            kind: m.meter_kind as string,
            quantity: m.quantity != null ? Number(m.quantity) : null,
            softLimit: m.soft_limit != null ? Number(m.soft_limit) : null,
            hardLimit: m.hard_limit != null ? Number(m.hard_limit) : null,
            unit: m.unit as string | null,
          })),
          failedWebhookCount: Number(failedRes.rows[0]?.org_count) || 0,
          unresolvedWebhookCount: Number(failedRes.rows[0]?.unresolved_null) || 0,
          connectors: connectorsRes.rows.map((c) => ({
            id: c.id,
            provider: c.connector_key,
            status: c.status,
            nangoConnectionId: c.nango_connection_id,
          })),
          orgAudit: auditRes.rows.map((row) => ({
            id: row.id as string,
            kind: row.kind as string | null,
            action: row.action as string | null,
            actorUserId: row.actor_user_id as string | null,
            resultStatus: row.result_status as string | null,
            payloadPreview: redactPayloadPreview(row.payload_preview),
            createdAt: row.created_at as string | Date | null,
          })),
          platformAudit: adminAuditRes.rows.map((row) => ({
            id: row.id as string,
            actorUserId: row.actor_user_id as string | null,
            platformRole: row.platform_role as string | null,
            action: row.action as string | null,
            reason: row.reason as string | null,
            createdAt: row.created_at as string | Date | null,
          })),
          billing: sub
            ? {
                plan: sub.plan_key as string | null,
                provider: sub.provider as string | null,
                status: sub.status as string | null,
                seats: sub.seats != null ? Number(sub.seats) : null,
                cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
                dunningGraceEndsAt: sub.dunning_grace_ends_at as string | Date | null,
                providerCustomerId: sub.provider_customer_id as string | null,
                providerSubscriptionId: sub.provider_subscription_id as string | null,
                lastInvoiceStatus: invoices[0]?.status ?? null,
                paymentMethodLink: paymentMethodLink({
                  provider: sub.provider as string | null,
                  providerCustomerId: sub.provider_customer_id as string | null,
                  providerSubscriptionId: sub.provider_subscription_id as string | null,
                }),
                invoices,
              }
            : null,
          overrides: overridesRaw
            ? {
                seatCap: overridesRaw.seat_cap,
                meterCaps: (overridesRaw.meter_caps && typeof overridesRaw.meter_caps === 'object'
                  ? overridesRaw.meter_caps
                  : {}) as Record<string, { soft?: number | null; hard?: number | null }>,
                featureFlags: (overridesRaw.feature_flags &&
                typeof overridesRaw.feature_flags === 'object'
                  ? overridesRaw.feature_flags
                  : {}) as Record<string, boolean>,
              }
            : null,
        };
      }
    );

    if (!detail) {
      return NextResponse.json(GENERIC_OR_NOT_FOUND, { status: 403 });
    }

    let llmCost: number | 'unknown' = 'unknown';
    let llmCostError: string | null = null;
    try {
      resolveLangfuseConfig();
      const cost = await fetchOrgWeeklyCost(orgId);
      llmCost = cost.weeklyCostUsd;
    } catch (err) {
      llmCost = 'unknown';
      if (
        err instanceof LangfuseUnavailableError ||
        err instanceof LangfuseConfigError
      ) {
        llmCostError = err.message.slice(0, 200);
      } else if (err instanceof Error) {
        llmCostError = err.message.slice(0, 200);
      } else {
        llmCostError = 'Langfuse cost unavailable';
      }
    }

    return NextResponse.json({ ...detail, llmCost, llmCostError });
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('GET /api/platform/orgs/[orgId]', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/** Generic body — does not reveal whether the org is missing or the caller is unauthorized. */
const GENERIC_OR_NOT_FOUND = { error: 'Forbidden' };
