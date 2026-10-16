/**
 * Multi-employee collision control (11 §8).
 * Precedence: customer > operations > growth.
 * One outbound message per customer per day, org-wide.
 * Missing 023 tables (42P01) do not block the caller.
 */
import type { EmployeeRole } from '@darex/shared-types';
import type { PoolClient } from 'pg';
import { isUndefinedTable } from '../db.js';
import { EMPLOYEE_PRECEDENCE, OUTBOUND_DAILY_CAP } from './types.js';

export { EMPLOYEE_PRECEDENCE, OUTBOUND_DAILY_CAP };

export function contestsLease(holder: EmployeeRole, challenger: EmployeeRole): boolean {
  return EMPLOYEE_PRECEDENCE[challenger] > EMPLOYEE_PRECEDENCE[holder];
}

export async function tryAcquireLease(
  client: PoolClient,
  input: {
    orgId: string;
    entityKey: string;
    employeeRole: EmployeeRole;
    workflowId: string;
    ttlMinutes?: number;
  }
): Promise<{ acquired: boolean; holder?: string; deferMs: number; reasonCode: 'lease_acquired' | 'lease_contested' }> {
  const ttl = input.ttlMinutes ?? 5;
  try {
    const existing = await client.query(
      `SELECT employee_role, workflow_id
         FROM agent_entity_leases
        WHERE org_id = $1 AND entity_key = $2 AND expires_at > NOW()`,
      [input.orgId, input.entityKey]
    );
    if (existing.rows[0] && existing.rows[0].workflow_id !== input.workflowId) {
      const holder = String(existing.rows[0].employee_role) as EmployeeRole;
      if (!contestsLease(holder, input.employeeRole)) {
        return { acquired: false, holder, deferMs: ttl * 60_000, reasonCode: 'lease_contested' };
      }
    }
    await client.query(
      `INSERT INTO agent_entity_leases (org_id, entity_key, employee_role, workflow_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)
       ON CONFLICT (org_id, entity_key)
       DO UPDATE SET employee_role = EXCLUDED.employee_role,
                     workflow_id = EXCLUDED.workflow_id,
                     expires_at = EXCLUDED.expires_at`,
      [input.orgId, input.entityKey, input.employeeRole, input.workflowId, String(ttl)]
    );
    return { acquired: true, holder: input.employeeRole, deferMs: 0, reasonCode: 'lease_acquired' };
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { acquired: true, holder: input.employeeRole, deferMs: 0, reasonCode: 'lease_acquired' };
    }
    throw err;
  }
}

export async function checkOutboundBudget(
  client: PoolClient,
  orgId: string,
  customerKey: string,
  cap = OUTBOUND_DAILY_CAP
): Promise<{ allowed: boolean; sentCount: number; cap: number; reasonCode: 'outbound_ok' | 'outbound_budget_exhausted' }> {
  try {
    const res = await client.query(
      `SELECT sent_count FROM agent_outbound_budget
        WHERE org_id = $1 AND customer_key = $2 AND window_date = CURRENT_DATE`,
      [orgId, customerKey]
    );
    const sentCount = Number(res.rows[0]?.sent_count ?? 0);
    if (sentCount >= cap) {
      return { allowed: false, sentCount, cap, reasonCode: 'outbound_budget_exhausted' };
    }
    return { allowed: true, sentCount, cap, reasonCode: 'outbound_ok' };
  } catch (err) {
    if (isUndefinedTable(err)) {
      return { allowed: true, sentCount: 0, cap, reasonCode: 'outbound_ok' };
    }
    throw err;
  }
}

/**
 * OE-05: capacity-aware routing. Picks the rep with the fewest currently
 * active enquiries; ties break on the rep least recently assigned so load
 * spreads round-robin rather than always landing on the same tied rep.
 */
export interface RepLoad {
  repId: string;
  activeCount: number;
  lastAssignedAt?: string | null;
}

export function pickLeastLoadedRep(reps: RepLoad[]): string | null {
  if (reps.length === 0) return null;
  const sorted = [...reps].sort((a, b) => {
    if (a.activeCount !== b.activeCount) return a.activeCount - b.activeCount;
    const aTime = a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0;
    const bTime = b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0;
    return aTime - bTime;
  });
  return sorted[0].repId;
}

export async function recordOutboundSend(
  client: PoolClient,
  orgId: string,
  customerKey: string
): Promise<number> {
  try {
    const res = await client.query(
      `INSERT INTO agent_outbound_budget (org_id, customer_key, window_date, sent_count)
       VALUES ($1, $2, CURRENT_DATE, 1)
       ON CONFLICT (org_id, customer_key, window_date)
       DO UPDATE SET sent_count = agent_outbound_budget.sent_count + 1
       RETURNING sent_count`,
      [orgId, customerKey]
    );
    return Number(res.rows[0]?.sent_count ?? 1);
  } catch (err) {
    if (isUndefinedTable(err)) return 1;
    throw err;
  }
}
