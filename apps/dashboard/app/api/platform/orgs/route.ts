import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/platform-admin';
import {
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/platform/orgs — org directory (audited read).
 * Health is alert count from the latest daily snapshot, or "unknown".
 * Never invents a healthy zero.
 */
export async function GET() {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;

    const orgs = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'org.list',
        reason: 'directory',
      },
      async (client) => {
        const res = await client.query<{
          id: string;
          name: string;
          slug: string;
          status: string;
          plan: string;
          suspended_by: string | null;
          subscription_status: string | null;
          seats: number | null;
          seat_cap: number | null;
          dunning_grace_ends_at: Date | null;
          last_activity_at: Date | null;
          connected_connectors: string;
          alert_count: string | null;
          has_snapshot: boolean;
        }>(
          `SELECT
             o.id,
             o.name,
             o.slug,
             o.status,
             o.plan,
             o.suspended_by,
             bs.status AS subscription_status,
             bs.seats,
             ov.seat_cap,
             bs.dunning_grace_ends_at,
             GREATEST(ae.last_at, msg.last_at) AS last_activity_at,
             COALESCE(oc.connected_count, 0)::text AS connected_connectors,
             snap.alert_count,
             (snap.metric_date IS NOT NULL) AS has_snapshot
           FROM orgs o
           LEFT JOIN LATERAL (
             SELECT status, seats, dunning_grace_ends_at
               FROM billing_subscriptions
              WHERE org_id = o.id
              ORDER BY updated_at DESC NULLS LAST
              LIMIT 1
           ) bs ON true
           LEFT JOIN org_plan_overrides ov ON ov.org_id = o.id
           LEFT JOIN LATERAL (
             SELECT MAX(created_at) AS last_at
               FROM audit_events
              WHERE org_id = o.id
           ) ae ON true
           LEFT JOIN LATERAL (
             SELECT MAX(created_at) AS last_at
               FROM messages
              WHERE org_id = o.id
           ) msg ON true
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS connected_count
               FROM org_connectors
              WHERE org_id = o.id AND status = 'connected'
           ) oc ON true
           LEFT JOIN LATERAL (
             SELECT
               metric_date,
               COALESCE(jsonb_array_length(band_alerts), 0)::text AS alert_count
               FROM org_employee_metrics_daily
              WHERE org_id = o.id
              ORDER BY metric_date DESC
              LIMIT 1
           ) snap ON true
           ORDER BY o.name ASC
           LIMIT 500`
        );

        return res.rows.map((row) => {
          const alertCount = row.has_snapshot ? Number(row.alert_count) || 0 : null;
          // Never invent healthy when no snapshot exists.
          const health: 'alert' | 'ok' | 'unknown' = !row.has_snapshot
            ? 'unknown'
            : alertCount != null && alertCount > 0
              ? 'alert'
              : 'ok';
          return {
            id: row.id,
            name: row.name,
            slug: row.slug,
            status: row.status,
            plan: row.plan,
            subscriptionStatus: row.subscription_status,
            seats: row.seats,
            seatCap: row.seat_cap,
            seatCount: row.seats,
            lastActivityAt: row.last_activity_at,
            connectorCount: Number(row.connected_connectors) || 0,
            connectedConnectors: Number(row.connected_connectors) || 0,
            dunningGraceEndsAt: row.dunning_grace_ends_at,
            dunning: Boolean(row.dunning_grace_ends_at),
            suspendedBy: row.suspended_by,
            health,
            healthAlertCount: alertCount,
          };
        });
      }
    );

    return NextResponse.json({ orgs });
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('GET /api/platform/orgs', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
