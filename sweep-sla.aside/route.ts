import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole, type HumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

function canSweep(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

/**
 * Marks open work items past sla_due_at as breached.
 * Sets sla_breached_at = NOW() only when the deadline has actually passed —
 * never invents SLA timestamps.
 */
export async function POST() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canSweep(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const res = await client.query(
        `UPDATE work_items
            SET sla_breached_at = NOW(),
                status = CASE
                  WHEN status IN ('done', 'cancelled', 'completed') THEN status
                  ELSE 'needs_attention'
                END,
                updated_at = NOW()
          WHERE org_id = $1
            AND sla_due_at IS NOT NULL
            AND sla_due_at <= NOW()
            AND sla_breached_at IS NULL
            AND status NOT IN ('done', 'cancelled', 'completed')
          RETURNING id, sla_due_at, sla_breached_at, status`,
        [orgId]
      );

      for (const row of res.rows) {
        try {
          await client.query(
            `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
             VALUES ($1, $2, 'sla_breached', $3::jsonb, $4, $5)
             ON CONFLICT DO NOTHING`,
            [
              orgId,
              row.id,
              JSON.stringify({
                slaDueAt: row.sla_due_at,
                slaBreachedAt: row.sla_breached_at,
                previousStatus: 'open',
              }),
              userId,
              `sla_breached:${row.id}:${row.sla_breached_at?.toISOString?.() || String(row.sla_breached_at)}`,
            ]
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/work_events|does not exist|relation/i.test(message)) {
            console.error('sla_breached event insert failed:', err);
          }
        }
      }

      return NextResponse.json({
        orgId,
        breachedCount: res.rowCount || 0,
        breached: res.rows.map((r) => ({
          id: r.id,
          slaDueAt: r.sla_due_at,
          slaBreachedAt: r.sla_breached_at,
          status: r.status,
        })),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/work-items/sweep-sla Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
