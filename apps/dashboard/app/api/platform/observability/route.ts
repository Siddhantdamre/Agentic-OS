import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/platform-admin';
import {
  getPlatformPool,
  isPlatformSchemaMissing,
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';

export const dynamic = 'force-dynamic';

/**
 * Thin ready sample for the platform aggregate.
 * Full dependency matrix lives in GET /api/health/ready (not re-entered via HTTP).
 * That handler does not export its checker; we probe Postgres on the platform pool only.
 */
async function thinPlatformReady(): Promise<{
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  note: string;
  checks: { postgres: { status: 'ok' | 'error'; latencyMs?: number; detail?: string } };
}> {
  const start = Date.now();
  try {
    const pool = getPlatformPool();
    await pool.query('SELECT 1');
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      note: 'Thin platform-pool probe. Full ready matrix: GET /api/health/ready',
      checks: { postgres: { status: 'ok', latencyMs: Date.now() - start } },
    };
  } catch (err) {
    return {
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      note: 'Thin platform-pool probe. Full ready matrix: GET /api/health/ready',
      checks: {
        postgres: {
          status: 'error',
          latencyMs: Date.now() - start,
          detail: err instanceof Error ? err.message.slice(0, 120) : 'unreachable',
        },
      },
    };
  }
}

/**
 * GET /api/platform/observability — audited platform aggregate.
 * Reads snapshots; does not loop GET /api/observability/metrics.
 */
export async function GET() {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;

    const ready = await thinPlatformReady();

    const aggregate = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'platform.observability.read',
        reason: 'observability',
      },
      async (client) => {
        const statusCounts = await client.query<{ status: string; count: string }>(
          `SELECT status, COUNT(*)::text AS count
             FROM orgs
            GROUP BY status
            ORDER BY status`
        );

        const dunning = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM billing_subscriptions
            WHERE status = 'past_due'
               OR dunning_grace_ends_at IS NOT NULL`
        );

        const meters = await client.query<{ meter_kind: string; total: string }>(
          `SELECT meter_kind, COALESCE(SUM(quantity), 0)::text AS total
             FROM billing_meters
            WHERE period_end >= CURRENT_DATE
            GROUP BY meter_kind
            ORDER BY meter_kind`
        );

        let alertOrgs: Array<{
          orgId: string;
          name: string;
          metricNames: string[];
          metricDate: string;
        }> = [];
        try {
          // Snapshots store alert metric keys in band_alerts JSONB (no status column).
          const alerts = await client.query<{
            org_id: string;
            name: string;
            band_alerts: unknown;
            metric_date: string;
          }>(
            `SELECT DISTINCT ON (d.org_id)
               d.org_id, o.name, d.band_alerts, d.metric_date::text
               FROM org_employee_metrics_daily d
               JOIN orgs o ON o.id = d.org_id
              WHERE jsonb_typeof(d.band_alerts) = 'array'
                AND jsonb_array_length(d.band_alerts) > 0
              ORDER BY d.org_id, d.metric_date DESC`
          );
          alertOrgs = alerts.rows.map((row) => {
            const names = Array.isArray(row.band_alerts)
              ? row.band_alerts.map((v) => String(v))
              : [];
            return {
              orgId: row.org_id,
              name: row.name,
              metricNames: names,
              metricDate: row.metric_date,
            };
          });
        } catch (err) {
          if (!isPlatformSchemaMissing(err)) throw err;
          // Missing metrics table → unknown, never a fake-empty green.
          return {
            orgsByStatus: Object.fromEntries(
              statusCounts.rows.map((r) => [r.status, Number(r.count) || 0])
            ),
            orgCountsByStatus: Object.fromEntries(
              statusCounts.rows.map((r) => [r.status, Number(r.count) || 0])
            ),
            dunningSubscriptionCount: Number(dunning.rows[0]?.count) || 0,
            dunningCount: Number(dunning.rows[0]?.count) || 0,
            meterSums: Object.fromEntries(
              meters.rows.map((r) => [r.meter_kind, Number(r.total) || 0])
            ),
            meterTotals: Object.fromEntries(
              meters.rows.map((r) => [r.meter_kind, Number(r.total) || 0])
            ),
            alertOrgs: null,
            failedWebhooks: null,
            failedWebhooksByOrg: null,
            observabilityMissing: true,
          };
        }

        const failed = await client.query<{ org_id: string | null; count: string }>(
          `SELECT org_id, COUNT(*)::text AS count
             FROM failed_webhooks
            GROUP BY org_id
            ORDER BY count DESC
            LIMIT 100`
        );

        const orgCounts = Object.fromEntries(
          statusCounts.rows.map((r) => [r.status, Number(r.count) || 0])
        );
        const meterTotals = Object.fromEntries(
          meters.rows.map((r) => [r.meter_kind, Number(r.total) || 0])
        );
        const dunningCount = Number(dunning.rows[0]?.count) || 0;
        const failedWebhooks = failed.rows.map((r) => ({
          orgId: r.org_id,
          count: Number(r.count) || 0,
        }));

        return {
          orgsByStatus: orgCounts,
          orgCountsByStatus: orgCounts,
          dunningSubscriptionCount: dunningCount,
          dunningCount,
          meterSums: meterTotals,
          meterTotals,
          alertOrgs,
          failedWebhooks,
          failedWebhooksByOrg: failedWebhooks.map((r) => ({
            orgId: r.orgId ?? 'unresolved',
            count: r.count,
          })),
        };
      }
    );

    return NextResponse.json({
      ready: {
        status: ready.status === 'healthy' ? 'ok' : ready.status,
        checks: ready.checks,
        note: ready.note,
        timestamp: ready.timestamp,
      },
      ...aggregate,
      // Aggregate does not compute org LLM spend — stay unknown, never $0.
      llmCost: 'unknown' as const,
    });
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('GET /api/platform/observability', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
