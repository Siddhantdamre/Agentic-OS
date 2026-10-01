/**
 * Plan steps run as the employee stamped on them (ASK-S02, ASK-G03): that
 * employee's card allowlist, persona denials and autonomy/confirm gate —
 * never a list derived from the plan's own tool names.
 */

import { withOrgScopedClient } from './tools/shared.js';
import { mergeRuntimeAllowlist } from './tool-executor.js';

export type PlanStepActor =
  | { ok: true; employeeId: string; employeeRole: string; toolAllowlist: string[] }
  | { ok: false; reason: 'missing_employee' | 'employee_unavailable'; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseAllowlist(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Pure: turn a loaded employee row into the actor a step executes as. */
export function actorFromEmployeeRow(
  row: { id: string; role: string | null; tool_allowlist: unknown; status: string } | undefined,
): PlanStepActor {
  if (!row || row.status !== 'active') {
    return {
      ok: false,
      reason: 'employee_unavailable',
      message: 'The employee assigned to this step is no longer active. Re-plan to assign another employee.',
    };
  }
  const role = String(row.role || '');
  return {
    ok: true,
    employeeId: row.id,
    employeeRole: role,
    toolAllowlist: mergeRuntimeAllowlist(parseAllowlist(row.tool_allowlist), [], role),
  };
}

export async function resolvePlanStepActor(
  orgId: string,
  step: { employeeId?: unknown; employeeRole?: unknown },
  fallbackEmployeeId?: string,
  fallbackEmployeeRole?: string,
): Promise<PlanStepActor> {
  const stepEmpId = typeof step.employeeId === 'string' ? step.employeeId.trim() : '';
  const employeeId = stepEmpId || (typeof fallbackEmployeeId === 'string' ? fallbackEmployeeId.trim() : '');
  const stepRole = typeof step.employeeRole === 'string' ? step.employeeRole.trim() : '';
  const role = stepRole || (typeof fallbackEmployeeRole === 'string' ? fallbackEmployeeRole.trim() : '');

  if (!UUID_RE.test(employeeId) && !role) {
    return {
      ok: false,
      reason: 'missing_employee',
      message: 'This step has no assigned employee, so it cannot run. Re-plan the request.',
    };
  }

  let row: { id: string; role: string | null; tool_allowlist: unknown; status: string } | undefined;
  await withOrgScopedClient(orgId, async (client) => {
    if (UUID_RE.test(employeeId)) {
      const res = await client.query(
        `SELECT id, role, tool_allowlist, status FROM ai_employees
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
        [employeeId, orgId],
      );
      row = res.rows[0];
    } else if (role) {
      const res = await client.query(
        `SELECT id, role, tool_allowlist, status FROM ai_employees
          WHERE org_id = $1 AND role = $2 AND archived_at IS NULL AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
        [orgId, role],
      );
      row = res.rows[0];
    }
  });

  return actorFromEmployeeRow(row);
}
