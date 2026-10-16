import { isUndefinedTable, withOrgClient, workerPool } from '../db.js';

/** Org statuses whose periodic sweeps keep running. Anything else stops them. */
export const SWEEP_RUNNABLE_STATUSES = ['active', 'provisioning'] as const;

export function isSweepRunnableStatus(status: string | null | undefined): boolean {
  return (SWEEP_RUNNABLE_STATUSES as readonly string[]).includes(String(status || ''));
}

/**
 * Checked on every sweep pass, not only at worker boot: a suspended,
 * soft-deleted or purged org stops its sweeps on the next pass (OPS-G07).
 * Missing org → not runnable.
 */
export async function sweepOrgActiveActivity(input: {
  orgId: string;
}): Promise<{ active: boolean; status: string | null }> {
  // Not withOrgClient: it throws for suspended orgs, and the retrying
  // activity would then fail the sweep instead of letting it end cleanly.
  const client = await workerPool.connect();
  let status: string | null = null;
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [input.orgId]);
    const res = await client.query<{ status: string | null }>(
      `SELECT status FROM orgs WHERE id = $1 LIMIT 1`,
      [input.orgId]
    );
    status = res.rows[0]?.status ? String(res.rows[0].status).trim().toLowerCase() : null;
  } finally {
    await client.query('RESET app.current_org_id').catch(() => undefined);
    client.release();
  }
  return { active: isSweepRunnableStatus(status), status };
}

/** YYYY-MM-DD in `timeZone` (falls back to UTC on a bad zone). */
export function localDateKey(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** ISO week key, e.g. 2026-W40 (UTC). */
export function isoWeekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Claim one run of a periodic side effect per period, so a restarted sweep
 * (worker restart, workflow re-start after completion) never delivers twice
 * in the same period (OPS-B06: duplicate morning brief on every boot).
 */
export async function claimSweepRunActivity(input: {
  orgId: string;
  kind: string;
  period: 'day' | 'week';
  timeZone?: string;
}): Promise<{ claimed: boolean; runKey: string }> {
  const now = new Date();
  const periodKey = input.period === 'day' ? localDateKey(now, input.timeZone || 'UTC') : isoWeekKey(now);
  const runKey = `sweep-run:${input.kind}:${periodKey}`;
  const ttlDays = input.period === 'day' ? 2 : 8;
  const claimed = await withOrgClient(input.orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO idempotency_keys (key, org_id, result, expires_at)
       VALUES ($1, $2, $3::jsonb, NOW() + make_interval(days => $4))
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [`${input.orgId}:${runKey}`, input.orgId, JSON.stringify({ status: 'claimed' }), ttlDays]
    );
    return (res.rowCount ?? 0) > 0;
  });
  return { claimed, runKey };
}

export const EXPIRE_DECISIONS_SQL = `UPDATE agent_pending_actions
    SET status = 'expired', decided_at = NOW(), decided_by = NULL
  WHERE org_id = $1
    AND status = 'pending'
    AND expires_at IS NOT NULL
    AND expires_at <= NOW()
  RETURNING id, work_item_id, action_type`;

/**
 * Decision expiry (OPS-G01). Expiry never approves. decided_by stays NULL —
 * no human decided — and each expiry gets a system audit row.
 */
export async function expirePendingDecisionsActivity(input: {
  orgId: string;
}): Promise<{ expired: number }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      await client.query('BEGIN');
      try {
        const res = await client.query<{ id: string; work_item_id: string | null; action_type: string }>(
          EXPIRE_DECISIONS_SQL,
          [input.orgId]
        );
        for (const row of res.rows) {
          await client.query(
            `INSERT INTO audit_events (org_id, kind, actor_type, actor_component, work_item_id,
                                       action, risk_class, result_status, payload)
             VALUES ($1, 'decision.expired', 'system', 'decision-expiry-sweep', $2,
                     'decision.expired', 'medium', 'denied', $3::jsonb)`,
            [input.orgId, row.work_item_id, JSON.stringify({ pendingActionId: row.id, actionType: row.action_type })]
          );
          if (row.work_item_id) {
            await client.query(
              `UPDATE work_items SET status = 'cancelled', updated_at = NOW()
                WHERE id = $1 AND org_id = $2 AND type = 'decision'
                  AND status NOT IN ('done', 'cancelled', 'completed')`,
              [row.work_item_id, input.orgId]
            );
          }
        }
        await client.query('COMMIT');
        return { expired: res.rowCount ?? 0 };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { expired: 0 };
    throw err;
  }
}

export const BREACH_SLA_SQL = `UPDATE work_items
    SET sla_breached_at = NOW(),
        status = 'needs_attention',
        updated_at = NOW()
  WHERE org_id = $1
    AND sla_due_at IS NOT NULL
    AND sla_due_at <= NOW()
    AND sla_breached_at IS NULL
    AND status NOT IN ('done', 'cancelled', 'completed')
  RETURNING id, sla_due_at, sla_breached_at`;

/** Work-item SLA breach (OPS-G01): same rule as POST /api/work-items/sweep-sla, run by the worker. */
export async function breachWorkItemSlaActivity(input: {
  orgId: string;
}): Promise<{ breached: number }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const res = await client.query<{ id: string; sla_due_at: string; sla_breached_at: string }>(
        BREACH_SLA_SQL,
        [input.orgId]
      );
      for (const row of res.rows) {
        await client.query(
          `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
           VALUES ($1, $2, 'sla_breached', $3::jsonb, 'system:sla-sweep', $4)
           ON CONFLICT DO NOTHING`,
          [
            input.orgId,
            row.id,
            JSON.stringify({ slaDueAt: row.sla_due_at, slaBreachedAt: row.sla_breached_at }),
            `sla_breached:${row.id}:${String(row.sla_breached_at)}`,
          ]
        );
      }
      return { breached: res.rowCount ?? 0 };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { breached: 0 };
    throw err;
  }
}
