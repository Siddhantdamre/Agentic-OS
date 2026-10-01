/**
 * Named gate hooks called from the ordered tool gate (`tool-gate.ts`).
 *
 * Each hook returns `null` to allow or a deny object. `gateOrgRunnable` is the
 * kill switch + org lifecycle check (17 §2 step 2). `gatePayRbac` and
 * `gateEntitlement` are filled by the security and billing workstreams; until
 * then they allow, and the pay confirm class still parks every pay action.
 */
import type { PoolClient } from 'pg';
import { canCallPayTools, ORG_HUMAN_ROLES, type OrgHumanRole } from '@darex/shared-types';
import type { ToolRisk } from './risk.js';
import { dbPool } from './shared.js';
import { parseStage, type RolloutStage } from '../employee-gate.js';

function parseHumanRole(value: unknown): OrgHumanRole {
  const raw = String(value || '').trim().toLowerCase();
  return (ORG_HUMAN_ROLES as readonly string[]).includes(raw) ? (raw as OrgHumanRole) : 'member';
}

export type GateDenyReason =
  | 'kill_switch'
  | 'org_not_runnable'
  | 'shadow'
  | 'usage_blocked'
  | 'missing_employee'
  | 'not_in_allowlist'
  | 'persona_denied'
  | 'invalid_args'
  | 'no_schema'
  | 'not_connected'
  | 'revoked'
  | 'api_error'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'critic'
  | 'quiet_hours'
  | 'customer_cap'
  | 'policy_denied';

export interface GateDeny {
  reason: GateDenyReason;
  message: string;
}

export interface OrgRunState {
  runnable: boolean;
  reason?: 'kill_switch' | 'org_not_runnable';
  stage: RolloutStage;
}

export interface GateHookContext {
  orgId: string;
  employeeId: string;
  employeeRole: string;
  actorUserId?: string;
  source?: string;
  tool: string;
  action: string;
  risk: ToolRisk | null;
}

const RUN_STATE_TTL_MS = 5_000;
const runStateCache = new Map<string, { state: OrgRunState; expiresAt: number }>();

export function clearOrgRunStateCache(): void {
  runStateCache.clear();
}

/**
 * Kill switch, org status, and rollout stage for one org, cached ≤5 s.
 * Fails closed: a missing org or a DB error is not runnable.
 */
export async function gateOrgRunnable(orgId: string): Promise<OrgRunState> {
  const cached = runStateCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.state;

  let state: OrgRunState;
  let client: PoolClient;
  try {
    client = await dbPool.connect();
  } catch {
    return { runnable: false, reason: 'org_not_runnable', stage: 0 };
  }
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    const res = await client.query<{ status: string | null; kill_switch: boolean | null; autonomy_stage: number | null }>(
      `SELECT o.status, c.kill_switch, c.autonomy_stage
         FROM orgs o
         LEFT JOIN org_runtime_controls c ON c.org_id = o.id
        WHERE o.id = $1
        LIMIT 1`,
      [orgId],
    );
    const row = res.rows[0];
    const status = String(row?.status || '').trim().toLowerCase();
    if (!row || status === 'suspended' || status === 'soft_deleted') {
      state = { runnable: false, reason: 'org_not_runnable', stage: 0 };
    } else if (row.kill_switch) {
      state = { runnable: false, reason: 'kill_switch', stage: 0 };
    } else {
      state = { runnable: true, stage: parseStage(Number(row.autonomy_stage ?? 0)) };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tool-gate] org run state unreadable for ${orgId}; failing closed: ${message}`);
    return { runnable: false, reason: 'org_not_runnable', stage: 0 };
  } finally {
    try {
      await client.query('RESET app.current_org_id');
    } catch {
      // release below regardless
    }
    client.release();
  }
  runStateCache.set(orgId, { state, expiresAt: Date.now() + RUN_STATE_TTL_MS });
  return state;
}

/**
 * Pay tools on the approval path need a pay-capable approver (SEC-R01). This
 * is the last line of defense: the approval UI already checks this before
 * calling in, but a pay-risk call reaching here with no human behind it, or
 * an approver whose role can't call pay tools, is denied here too — a bug or
 * a future caller in either of those checks doesn't silently let a payment
 * through.
 */
export async function gatePayRbac(ctx: GateHookContext): Promise<GateDeny | null> {
  if (!ctx.actorUserId) {
    return { reason: 'persona_denied', message: 'A pay action needs a human approver on record.' };
  }
  const client = await dbPool.connect();
  try {
    const res = await client.query<{ role: string | null }>(`SELECT role FROM users WHERE id = $1 LIMIT 1`, [
      ctx.actorUserId,
    ]);
    const role = parseHumanRole(res.rows[0]?.role);
    if (!canCallPayTools(role)) {
      return { reason: 'persona_denied', message: `Role "${role}" cannot approve pay actions.` };
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tool-gate] pay RBAC lookup failed for ${ctx.actorUserId}; failing closed: ${message}`);
    return { reason: 'persona_denied', message: 'Could not verify approver role for a pay action.' };
  } finally {
    client.release();
  }
}

/** Plan entitlements (plan_limits) for this org and tool (BIZ-G01). */
export async function gateEntitlement(_ctx: GateHookContext): Promise<GateDeny | null> {
  return null;
}
