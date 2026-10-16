/**
 * Measures "is each AI employee doing its job?" for one workspace, in the database.
 *
 * It reuses the Trust page's counting (collectTrustSnapshot) for what people decided about each employee, and adds
 * what that page does not look at: when the employee last did anything, how long the oldest approval has waited
 * behind a person, and whether customer messages are failing to arrive. Callers pass a client that already carries
 * the session's workspace (getScopedClient); every query also names org_id.
 */
import type { PoolClient } from 'pg';
import { collectTrustSnapshot } from '@/lib/trust-query';
import {
  assessAgent,
  assessWorkspace,
  type BackgroundCheck,
  orderByAttention,
  type AgentHealthResult,
  type HealthStatus,
  type WorkspaceNote,
} from '@/lib/agent-health';

export interface AgentHealthRow extends AgentHealthResult {
  id: string;
  name: string;
  role: string;
  employeeStatus: string;
  lastActionAt: string | null;
  waiting: number;
  oldestWaitingHours: number | null;
  decided: number;
  approvedAsIs: number;
  approvedEdited: number;
  rejected: number;
  failedToRun: number;
}

export interface AgentHealthSnapshot {
  employees: AgentHealthRow[];
  notes: WorkspaceNote[];
  /** Counts by status, for a one-line summary. */
  summary: Record<HealthStatus, number>;
  asOf: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUR_MS = 3_600_000;

interface Emp { id: string; role: string }

/** Same rule as the Trust page: the named employee, else the only holder of the role, else nobody. */
function attribute(employees: Emp[], employeeId: string | null, role: string): string | null {
  if (employeeId && UUID.test(employeeId) && employees.some((e) => e.id === employeeId)) return employeeId;
  const sameRole = employees.filter((e) => e.role === role);
  return sameRole.length === 1 ? sameRole[0].id : null;
}

const later = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

export async function loadAgentHealth(client: PoolClient, orgId: string, now: Date = new Date()): Promise<AgentHealthSnapshot> {
  const trust = await collectTrustSnapshot(client, orgId, now);
  const emps: Emp[] = trust.employees.map((e) => ({ id: e.id, role: e.role }));

  const created = await client.query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM ai_employees WHERE org_id = $1`,
    [orgId],
  );
  const createdAt = new Map(created.rows.map((r) => [r.id, new Date(r.created_at).toISOString()]));

  const lastAction = new Map<string, string>();
  const ledger = await client.query<{ employee_id: string | null; employee_role: string; last_at: Date }>(
    `SELECT employee_id::text AS employee_id, employee_role, MAX(created_at) AS last_at
       FROM agent_decision_ledger
      WHERE org_id = $1
      GROUP BY 1, 2`,
    [orgId],
  );
  for (const r of ledger.rows) {
    const key = attribute(emps, r.employee_id, String(r.employee_role ?? ''));
    if (!key) continue;
    const at = new Date(r.last_at).toISOString();
    lastAction.set(key, later(lastAction.get(key) ?? null, at) as string);
  }

  const oldestWaiting = new Map<string, Date>();
  const waiting = await client.query<{ employee_id: string | null; employee_role: string; oldest: Date }>(
    `SELECT NULLIF(payload->>'employeeId', '') AS employee_id, employee_role, MIN(created_at) AS oldest
       FROM agent_pending_actions
      WHERE org_id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > $2)
      GROUP BY 1, 2`,
    [orgId, now.toISOString()],
  );
  for (const r of waiting.rows) {
    const key = attribute(emps, r.employee_id, String(r.employee_role ?? ''));
    if (!key) continue;
    const at = new Date(r.oldest);
    const prev = oldestWaiting.get(key);
    if (!prev || at < prev) oldestWaiting.set(key, at);
  }

  const dlq = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM failed_webhooks WHERE org_id = $1 AND status = 'unresolved'`,
    [orgId],
  );

  // The worker's heartbeat. A workspace on a database without the table yet reads as "nothing recorded", not a failure.
  let backgroundChecks: BackgroundCheck[] = [];
  try {
    const hb = await client.query<{ activity: string; last_ok_at: Date | null; last_error_at: Date | null; last_error: string | null; fail_count: string }>(
      `SELECT activity, last_ok_at, last_error_at, last_error, fail_count::text AS fail_count
         FROM agent_activity_health WHERE org_id = $1`,
      [orgId],
    );
    backgroundChecks = hb.rows.map((r) => ({
      activity: r.activity,
      lastOkAt: r.last_ok_at ? new Date(r.last_ok_at).toISOString() : null,
      lastErrorAt: r.last_error_at ? new Date(r.last_error_at).toISOString() : null,
      lastError: r.last_error,
      failCount: Number(r.fail_count),
    }));
  } catch (err) {
    if ((err as { code?: string }).code !== '42P01') throw err;
  }

  const rows: AgentHealthRow[] = trust.employees.map((e) => {
    const lastActionAt = later(lastAction.get(e.id) ?? null, e.evidence.lastDecisionAt);
    const oldest = oldestWaiting.get(e.id);
    const input = {
      name: e.name,
      role: e.role,
      status: e.status,
      createdAt: createdAt.get(e.id) ?? now.toISOString(),
      lastActionAt,
      waiting: e.evidence.waiting,
      oldestWaitingHours: oldest ? Math.floor((now.getTime() - oldest.getTime()) / HOUR_MS) : null,
      decided: e.evidence.approvedAsIs + e.evidence.approvedEdited + e.evidence.rejected,
      approvedAsIs: e.evidence.approvedAsIs,
      approvedEdited: e.evidence.approvedEdited,
      rejected: e.evidence.rejected,
      failedToRun: e.evidence.failedToRun,
    };
    const verdict = assessAgent(input, now);
    return {
      ...verdict,
      id: e.id,
      name: e.name,
      role: e.role,
      employeeStatus: e.status,
      lastActionAt,
      waiting: input.waiting,
      oldestWaitingHours: input.oldestWaitingHours,
      decided: input.decided,
      approvedAsIs: input.approvedAsIs,
      approvedEdited: input.approvedEdited,
      rejected: input.rejected,
      failedToRun: input.failedToRun,
    };
  });

  const summary: Record<HealthStatus, number> = { stuck: 0, watch: 0, ok: 0, new: 0, paused: 0 };
  for (const r of rows) summary[r.status]++;
  const notes = assessWorkspace({ webhookFailuresWaiting: Number(dlq.rows[0]?.n ?? 0), killSwitch: trust.killSwitch, backgroundChecks }, now);
  return { employees: orderByAttention(rows), notes, summary, asOf: now.toISOString() };
}
