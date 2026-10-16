import type { PoolClient } from 'pg';

export interface EmployeePerformance {
  employeeId: string;
  totalAssigned: number;
  open: number;
  completed: number;
  completedLast7d: number;
  /** Mean hours from creation to last update over completed items. null = no completed items. */
  avgResolutionHours: number | null;
  /** completed / (completed + cancelled). null when nothing has finished yet. */
  completionRate: number | null;
  /**
   * Share of this employee's gated decisions (last 30d) that were allowed:
   * executed / (executed + declined + escalated). Deferred and suppressed
   * rows are not verdicts. null (never 0) when the employee has no such history.
   */
  approvalRate: number | null;
  /** Count of decisions behind approvalRate, so a UI can show "n=3". */
  approvalSample: number;
}

function toNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function buildEmployeePerformance(
  employeeId: string,
  row: Record<string, unknown> | undefined,
  ledger?: Record<string, unknown>,
): EmployeePerformance {
  const allowed = toNum(ledger?.executed);
  const verdicts = allowed + toNum(ledger?.declined) + toNum(ledger?.escalated);
  const completed = toNum(row?.completed);
  const cancelled = toNum(row?.cancelled);
  const finished = completed + cancelled;
  const avgRaw = row?.avg_resolution_hours;
  const avg = avgRaw == null ? null : Number(avgRaw);
  return {
    employeeId,
    totalAssigned: toNum(row?.total),
    open: toNum(row?.open),
    completed,
    completedLast7d: toNum(row?.completed_7d),
    avgResolutionHours: avg != null && Number.isFinite(avg) ? Math.round(avg * 10) / 10 : null,
    completionRate: finished > 0 ? Math.round((completed / finished) * 1000) / 1000 : null,
    approvalRate: verdicts > 0 ? Math.round((allowed / verdicts) * 1000) / 1000 : null,
    approvalSample: verdicts,
  };
}

function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  // 42P01 undefined_table, 42703 undefined_column (employee_id before migration 205)
  return code === '42P01' || code === '42703';
}

/**
 * Per-employee performance keyed on the employee UUID (work_items.assignee_employee_id
 * and agent_decision_ledger.employee_id), so two employees sharing a role are never
 * blended. Real counts only; no synthetic values.
 */
export async function loadEmployeePerformance(
  client: PoolClient,
  orgId: string,
  employeeId: string,
): Promise<EmployeePerformance> {
  let row: Record<string, unknown> | undefined;
  try {
    const res = await client.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status NOT IN ('done', 'cancelled')) AS open,
              COUNT(*) FILTER (WHERE status = 'done') AS completed,
              COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
              COUNT(*) FILTER (WHERE status = 'done' AND updated_at > NOW() - INTERVAL '7 days') AS completed_7d,
              AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600.0) FILTER (WHERE status = 'done') AS avg_resolution_hours
         FROM work_items
        WHERE org_id = $1 AND assignee_employee_id = $2`,
      [orgId, employeeId],
    );
    row = res.rows[0];
  } catch (err: unknown) {
    if (!isMissingRelation(err)) throw err;
  }

  let ledger: Record<string, unknown> | undefined;
  try {
    const res = await client.query(
      `SELECT COUNT(*) FILTER (WHERE decision = 'executed') AS executed,
              COUNT(*) FILTER (WHERE decision = 'declined') AS declined,
              COUNT(*) FILTER (WHERE decision = 'escalated') AS escalated
         FROM agent_decision_ledger
        WHERE org_id = $1 AND employee_id = $2
          AND created_at > NOW() - INTERVAL '30 days'`,
      [orgId, employeeId],
    );
    ledger = res.rows[0];
  } catch (err: unknown) {
    if (!isMissingRelation(err)) throw err;
  }
  return buildEmployeePerformance(employeeId, row, ledger);
}
