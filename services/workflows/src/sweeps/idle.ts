/**
 * SQL-first idle path (21). A sweep pass with nothing due costs one indexed
 * query and zero model calls. Missing 023 tables count as idle, not error.
 */

export const SWEEP_ACTION_CAP = 50;

export type SweepKind = 'open_loops' | 'stuck_work' | 'morning_check' | 'growth_watch';

export interface IdleSweepResult {
  idle: boolean;
  kind: SweepKind;
  dueCount: number;
  modelCalls: number;
}

export function assessSweepDueCount(kind: SweepKind, dueCount: number): IdleSweepResult {
  return {
    idle: dueCount <= 0,
    kind,
    dueCount: Math.max(0, dueCount),
    modelCalls: 0,
  };
}

export function capSweepActions(dueCount: number, cap = SWEEP_ACTION_CAP): { take: number; defer: number } {
  if (dueCount <= cap) return { take: dueCount, defer: 0 };
  return { take: cap, defer: dueCount - cap };
}

/** Indexed due counts. $1 = orgId, $2 = before ISO. Missing tables → idle. */
export const DUE_SQL: Record<SweepKind, string> = {
  open_loops: `SELECT COUNT(*)::int AS n FROM agent_open_loops
                WHERE org_id = $1 AND status NOT IN ('closed') AND target_check_at <= $2`,
  stuck_work: `SELECT COUNT(*)::int AS n FROM operational_expectations
                WHERE org_id = $1 AND settled_at IS NULL AND is_discrepancy = TRUE AND expected_by_timestamp <= $2`,
  morning_check: `SELECT COUNT(*)::int AS n FROM operational_enquiries
                   WHERE org_id = $1 AND state NOT IN ('closed')
                     AND sla_expires_at IS NOT NULL AND sla_expires_at <= $2`,
  growth_watch: `SELECT COUNT(*)::int AS n FROM lead_intent_signals
                  WHERE org_id = $1 AND detected_at <= $2`,
};
