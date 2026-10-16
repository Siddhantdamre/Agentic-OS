/**
 * Measures the evidence for the Trust page, in the database, for one workspace.
 *
 * Everything here is counted from rows the product itself wrote (people's
 * decisions on parked actions, what ran, operator answers about watching-mode
 * decisions). Nothing is accepted from a browser. Callers pass a client that
 * already carries the session's workspace (getScopedClient), and every query
 * also names org_id, so a mistake in one layer is caught by the other.
 */
import type { PoolClient } from 'pg';
import { loadRuntimeControls } from '@/lib/employee-metrics-query';
import type { RolloutStage } from '@/lib/employee-rollout';
import {
  summariseEmployee,
  type EmployeeCounts,
  type EmployeeEvidence,
  type WorkspaceEvidence,
} from '@/lib/trust-evidence';

const DAY_MS = 24 * 60 * 60 * 1000;
export const RECENT_WINDOW_DAYS = 30;
/** Evidence older than this never counts toward a stage, however long ago the stage began. */
const MAX_STAGE_WINDOW_DAYS = 120;

export interface TrustEmployee {
  id: string;
  name: string;
  role: string;
  status: string;
  evidence: EmployeeEvidence;
}

export interface StageEvent {
  id: string;
  fromStage: number;
  toStage: number;
  kind: 'advance' | 'override' | 'pull_back' | 'pause';
  reason: string | null;
  by: string | null;
  at: string;
  evidence: Record<string, unknown>;
}

export interface TrustSnapshot {
  stage: RolloutStage;
  killSwitch: boolean;
  /** When the workspace entered its current stage. */
  since: string;
  /** True when no stage change was ever recorded, so `since` is the best guess. */
  sinceApproximate: boolean;
  workspace: WorkspaceEvidence;
  employees: TrustEmployee[];
  /** Decisions that could not be tied to one employee (older, or made for a whole role). */
  unattributed: EmployeeEvidence;
  shadow: { reviewed: number; agreed: number; waiting: number };
  outcomesTracked: boolean;
  history: StageEvent[];
  asOf: string;
}

type Counts = EmployeeCounts;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function n(value: unknown): number {
  const v = Number(value);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function emptyCounts(outcomesTracked: boolean): Counts {
  return {
    approvedAsIs: 0, approvedEdited: 0, rejected: 0, expired: 0, waiting: 0, failedToRun: 0,
    carriedOut: 0, withProblems: 0, outcomesTracked, lastDecisionAt: null,
  };
}

interface EmployeeRow { id: string; name: string; role: string; status: string }

/**
 * Which employee does a row belong to? The acting employee when the row names one
 * that exists in this workspace; otherwise the only employee holding that role;
 * otherwise nobody in particular (never a guess between two people).
 */
function attribute(employees: EmployeeRow[], employeeId: string | null, role: string): string | null {
  if (employeeId && UUID.test(employeeId) && employees.some((e) => e.id === employeeId)) return employeeId;
  const sameRole = employees.filter((e) => e.role === role);
  return sameRole.length === 1 ? sameRole[0].id : null;
}

async function pendingByEmployee(
  client: PoolClient,
  orgId: string,
  employees: EmployeeRow[],
  since: Date,
  outcomesTracked: boolean,
): Promise<Map<string | null, Counts>> {
  const res = await client.query(
    `SELECT NULLIF(payload->>'employeeId', '')                                              AS employee_id,
            employee_role,
            COUNT(*) FILTER (WHERE status IN ('approved','executed','execution_failed') AND modified_payload IS NULL)     AS approved_as_is,
            COUNT(*) FILTER (WHERE status IN ('approved','executed','execution_failed') AND modified_payload IS NOT NULL) AS approved_edited,
            COUNT(*) FILTER (WHERE status = 'rejected')                                    AS rejected,
            COUNT(*) FILTER (WHERE status = 'expired')                                     AS expired,
            COUNT(*) FILTER (WHERE status = 'pending')                                     AS waiting,
            COUNT(*) FILTER (WHERE status = 'execution_failed')                            AS failed,
            MAX(decided_at)                                                                AS last_decided
       FROM agent_pending_actions
      WHERE org_id = $1 AND created_at >= $2
      GROUP BY 1, 2`,
    [orgId, since.toISOString()],
  );
  const out = new Map<string | null, Counts>();
  for (const row of res.rows) {
    const key = attribute(employees, row.employee_id, String(row.employee_role ?? ''));
    const c = out.get(key) ?? emptyCounts(outcomesTracked);
    c.approvedAsIs += n(row.approved_as_is);
    c.approvedEdited += n(row.approved_edited);
    c.rejected += n(row.rejected);
    c.expired += n(row.expired);
    c.waiting += n(row.waiting);
    c.failedToRun += n(row.failed);
    const last = row.last_decided ? new Date(row.last_decided).toISOString() : null;
    if (last && (!c.lastDecisionAt || last > c.lastDecisionAt)) c.lastDecisionAt = last;
    out.set(key, c);
  }
  return out;
}

async function carriedOutByEmployee(
  client: PoolClient,
  orgId: string,
  employees: EmployeeRow[],
  since: Date,
  into: Map<string | null, Counts>,
  outcomesTracked: boolean,
): Promise<void> {
  const res = await client.query(
    `SELECT l.employee_id::text AS employee_id,
            l.employee_role,
            COUNT(*)                                                                          AS carried_out,
            COUNT(*) FILTER (WHERE COALESCE(f.reverted, FALSE) OR COALESCE(f.complained, FALSE)) AS with_problems
       FROM agent_decision_ledger l
       LEFT JOIN outcome_feedback f ON f.decision_id = l.id AND f.org_id = l.org_id
      WHERE l.org_id = $1 AND l.decision = 'executed' AND l.created_at >= $2
      GROUP BY 1, 2`,
    [orgId, since.toISOString()],
  );
  for (const row of res.rows) {
    const key = attribute(employees, row.employee_id, String(row.employee_role ?? ''));
    const c = into.get(key) ?? emptyCounts(outcomesTracked);
    c.carriedOut += n(row.carried_out);
    c.withProblems += n(row.with_problems);
    into.set(key, c);
  }
}

function sum(counts: Iterable<Counts>, outcomesTracked: boolean): Counts {
  const t = emptyCounts(outcomesTracked);
  for (const c of counts) {
    t.approvedAsIs += c.approvedAsIs; t.approvedEdited += c.approvedEdited; t.rejected += c.rejected;
    t.expired += c.expired; t.waiting += c.waiting; t.failedToRun += c.failedToRun;
    t.carriedOut += c.carriedOut; t.withProblems += c.withProblems;
  }
  return t;
}

function ratioOf(approved: number, decided: number): number | null {
  return decided > 0 ? approved / decided : null;
}

export async function collectTrustSnapshot(client: PoolClient, orgId: string, now: Date = new Date()): Promise<TrustSnapshot> {
  const controls = await loadRuntimeControls(client, orgId);

  const eventRows = await client.query(
    `SELECT e.id, e.from_stage, e.to_stage, e.kind, e.reason, e.evidence, e.created_at, u.email AS actor_email
       FROM org_autonomy_stage_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.org_id = $1
      ORDER BY e.created_at DESC
      LIMIT 20`,
    [orgId],
  );
  const history: StageEvent[] = eventRows.rows.map((r) => ({
    id: String(r.id),
    fromStage: Number(r.from_stage),
    toStage: Number(r.to_stage),
    kind: r.kind,
    reason: r.reason ?? null,
    by: r.actor_email ?? null,
    at: new Date(r.created_at).toISOString(),
    evidence: (r.evidence && typeof r.evidence === 'object' ? r.evidence : {}) as Record<string, unknown>,
  }));

  // The newest recorded change dates the current stage only if it ended up at the stage the workspace
  // is at now. A pause by support, or a change made outside the app, leaves the history behind the
  // truth, and then the honest answer is an approximate date, not a confident wrong one.
  let since: Date;
  let sinceApproximate = false;
  if (history.length > 0 && history[0].toStage === controls.rolloutStage) {
    since = new Date(history[0].at);
  } else {
    sinceApproximate = true;
    const fallback = await client.query(
      `SELECT COALESCE((SELECT updated_at FROM org_runtime_controls WHERE org_id = $1),
                       (SELECT created_at FROM orgs WHERE id = $1)) AS started`,
      [orgId],
    );
    since = fallback.rows[0]?.started ? new Date(fallback.rows[0].started) : now;
  }
  const stageWindowStart = new Date(Math.max(since.getTime(), now.getTime() - MAX_STAGE_WINDOW_DAYS * DAY_MS));
  const recentStart = new Date(now.getTime() - RECENT_WINDOW_DAYS * DAY_MS);

  const employeeRows = await client.query(
    `SELECT id::text AS id, name, role, status FROM ai_employees WHERE org_id = $1 ORDER BY created_at, name`,
    [orgId],
  );
  const employees: EmployeeRow[] = employeeRows.rows.map((r) => ({
    id: String(r.id), name: String(r.name), role: String(r.role), status: String(r.status),
  }));

  const outcomesRow = await client.query(`SELECT EXISTS (SELECT 1 FROM outcome_feedback WHERE org_id = $1) AS tracked`, [orgId]);
  const outcomesTracked = Boolean(outcomesRow.rows[0]?.tracked);

  const recent = await pendingByEmployee(client, orgId, employees, recentStart, outcomesTracked);
  await carriedOutByEmployee(client, orgId, employees, recentStart, recent, outcomesTracked);
  const inStage = await pendingByEmployee(client, orgId, employees, stageWindowStart, outcomesTracked);

  const stageTotals = sum(inStage.values(), outcomesTracked);
  const recentTotals = sum(recent.values(), outcomesTracked);
  const stageDecided = stageTotals.approvedAsIs + stageTotals.approvedEdited + stageTotals.rejected;
  const recentDecided = recentTotals.approvedAsIs + recentTotals.approvedEdited + recentTotals.rejected;

  const shadowRow = await client.query(
    `SELECT COUNT(*) FILTER (WHERE r.id IS NULL)   AS waiting,
            COUNT(*) FILTER (WHERE r.id IS NOT NULL) AS reviewed,
            COUNT(*) FILTER (WHERE r.agreed)       AS agreed
       FROM agent_decision_ledger l
       LEFT JOIN agent_shadow_reviews r ON r.ledger_id = l.id AND r.org_id = l.org_id
      WHERE l.org_id = $1 AND l.decision = 'suppressed' AND l.reason_code = 'shadow_stage'`,
    [orgId],
  );
  const shadow = {
    waiting: n(shadowRow.rows[0]?.waiting),
    reviewed: n(shadowRow.rows[0]?.reviewed),
    agreed: n(shadowRow.rows[0]?.agreed),
  };

  const divergenceRow = await client.query(
    `SELECT COUNT(*) AS open_count
       FROM operational_expectations
      WHERE org_id = $1 AND is_discrepancy AND settled_at IS NULL AND created_at >= $2`,
    [orgId, stageWindowStart.toISOString()],
  );

  const workspace: WorkspaceEvidence = {
    stage: controls.rolloutStage,
    killSwitch: controls.killSwitch,
    weeksInStage: Math.max(0, (now.getTime() - since.getTime()) / (7 * DAY_MS)),
    stateDivergences: n(divergenceRow.rows[0]?.open_count),
    shadowReviewed: shadow.reviewed,
    shadowAgreed: shadow.agreed,
    decisionsInStage: stageDecided,
    approvalRate: ratioOf(stageTotals.approvedAsIs + stageTotals.approvedEdited, stageDecided),
    recentDecided,
    recentApprovalRate: ratioOf(recentTotals.approvedAsIs + recentTotals.approvedEdited, recentDecided),
  };

  return {
    stage: controls.rolloutStage,
    killSwitch: controls.killSwitch,
    since: since.toISOString(),
    sinceApproximate,
    workspace,
    employees: employees.map((e) => ({
      id: e.id,
      name: e.name,
      role: e.role,
      status: e.status,
      evidence: summariseEmployee(recent.get(e.id) ?? emptyCounts(outcomesTracked)),
    })),
    unattributed: summariseEmployee(recent.get(null) ?? emptyCounts(outcomesTracked)),
    shadow,
    outcomesTracked,
    history,
    asOf: now.toISOString(),
  };
}
