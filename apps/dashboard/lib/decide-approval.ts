/**
 * One decision path for parked autonomy actions (agent_pending_actions).
 *
 * /api/decisions PATCH, /api/agent/pending-actions POST, the inbox decision
 * card (/api/work-items/[id]/decision) and the chat approval tool all call
 * decideApproval so an approval always means the same thing: RBAC, dual
 * approval, audit that fails loudly, execute on the final approval.
 *
 * `orgId` and `actorUserId` must come from the authenticated session, never a
 * request body.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getOrgScopedClient } from '@/lib/db';
import { canCallPayTools, isPayTool, loadHumanRole, type HumanRole } from '@/lib/rbac';
import { AUDIT_EVENT_INSERT_SQL, type AuditEventKind } from '@/lib/audit-events';
import { publicErrorMessage } from '@/lib/public-error';

export type ApprovalDecision = 'approved' | 'rejected';

export type DecideApprovalInput = {
  pendingActionId: string;
  decision: ApprovalDecision;
  actorUserId: string;
  orgId: string;
  /** Replaces the parked tool args. Validated: plain object, ≤ 16 KB JSON. */
  modifiedPayload?: Record<string, unknown> | null;
  /** When set (link/token flows), must hash to agent_pending_actions.token_hash. */
  token?: string | null;
};

export type DecideApprovalStatus =
  | 'rejected'
  | 'pending'
  | 'executed'
  | 'execution_failed';

export type DecideApprovalResult =
  | {
      ok: true;
      httpStatus: 200;
      id: string;
      status: DecideApprovalStatus;
      awaitingApprovals?: number;
      approvals?: unknown;
      result?: unknown;
      error?: string;
    }
  | { ok: false; httpStatus: 400 | 403 | 404 | 409 | 500; error: string; id?: string };

type PendingPayload = {
  tool?: string;
  action?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

type ExecuteFn = (input: {
  tool: string;
  action: string;
  payload: Record<string, unknown>;
  orgId: string;
  /** The person who approved. The gate reads this for pay permission and to tell a person from a sweep. */
  actorUserId: string;
  employeeRole?: string;
  /** The employee that asked, so their tool card still applies. */
  employeeId?: string;
  workflowId?: string;
  skipAutonomy: true;
  /**
   * The row a person approved. Without it the gate sees a brand-new call, holds a send, payment, signature, publish or
   * delete for approval AGAIN, and the approval never does anything.
   */
  approvedPendingActionId: string;
  source: 'approval';
}) => Promise<unknown>;

export type DecideApprovalDeps = {
  getClient: (orgId: string) => Promise<{ client: PoolClient; orgId: string }>;
  execute: ExecuteFn;
  /** Parked tool execution timeout. The tool may still finish; the row says so. */
  executeTimeoutMs: number;
};

export const MAX_MODIFIED_PAYLOAD_BYTES = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AuditWriteError extends Error {
  constructor(kind: string, cause: unknown) {
    super(
      `audit_events insert for ${kind} failed: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'AuditWriteError';
  }
}

export function canDecide(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'member':
      return true;
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function canApproveRefund(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export function isRefundAction(actionType: string, payload: PendingPayload): boolean {
  return /refund/i.test(`${actionType} ${payload.tool || ''} ${payload.action || ''}`);
}

/** Pure policy check — who may approve this action. Returns an error string or null. */
export function approvalPolicyError(
  role: HumanRole,
  decision: ApprovalDecision,
  actionType: string,
  payload: PendingPayload
): string | null {
  if (!canDecide(role)) return 'Forbidden';
  if (decision === 'rejected') return null;
  if (isRefundAction(actionType, payload) && !canApproveRefund(role)) {
    return 'Only workspace owners and admins can approve refunds.';
  }
  const tool = String(payload.tool || '');
  if (tool && isPayTool(tool, String(payload.action || '')) && !canCallPayTools(role)) {
    return 'Your role cannot approve payment actions.';
  }
  return null;
}

export function validateModifiedPayload(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'modifiedPayload must be a JSON object';
  }
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 'modifiedPayload must be serialisable JSON';
  }
  if (size > MAX_MODIFIED_PAYLOAD_BYTES) {
    return `modifiedPayload exceeds ${MAX_MODIFIED_PAYLOAD_BYTES} bytes`;
  }
  return null;
}

function extractToolCall(payload: PendingPayload, modified?: Record<string, unknown> | null) {
  const tool = String(payload.tool || '');
  const action = String(payload.action || 'auto_execute');
  const base =
    payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
      ? payload.payload
      : {};
  const args = modified && typeof modified === 'object' ? modified : base;
  return { tool, action, args: args as Record<string, unknown> };
}

async function insertAudit(
  client: PoolClient,
  orgId: string,
  actorUserId: string,
  kind: AuditEventKind,
  resultStatus: 'ok' | 'error' | 'denied',
  riskClass: string,
  tool: string | null,
  workItemId: string | null,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await client.query(AUDIT_EVENT_INSERT_SQL, [
      orgId,
      kind,
      'user',
      actorUserId,
      null,
      null,
      workItemId,
      null,
      null,
      kind === 'decision.rejected' ? null : actorUserId,
      tool,
      kind,
      riskClass,
      null,
      null,
      null,
      resultStatus,
      [],
      JSON.stringify(payload),
    ]);
  } catch (err) {
    throw new AuditWriteError(kind, err);
  }
}

/** Run `fn` in a transaction; audit failure rolls the state change back. */
async function inTx<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

async function setWorkItemStatus(
  client: PoolClient,
  orgId: string,
  workItemId: string | null,
  status: 'done' | 'cancelled' | 'needs_attention'
): Promise<void> {
  if (!workItemId) return;
  await client.query(
    `UPDATE work_items SET status = $3, updated_at = NOW()
      WHERE id = $1 AND org_id = $2 AND type = 'decision'`,
    [workItemId, orgId, status]
  );
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Parked tool execution timed out after ${ms} ms; outcome unknown`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * A tool that answers with an error, or that was held for approval again, did not do what the person approved.
 * Recording it as executed (with a success audit entry) tells them it was sent when it was not. Null = it ran.
 * A result with no status is a raw provider answer from an older tool and counts as having run.
 */
function failureOf(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { status?: unknown; message?: unknown };
  if (r.status === undefined || r.status === 'executed') return null;
  if (r.status === 'pending_approval') return 'The action was held for approval again, so it did not run.';
  const safe = publicErrorMessage(typeof r.message === 'string' ? r.message : '', 'The action did not run.');
  // A provider's status code and raw reply ("HTTP 500 {...}") mean nothing to the person who clicked Approve.
  const m = safe.match(/^(.*?)[\s:.-]*\bHTTP\s*\d{3}\b/s);
  if (!m) return safe;
  const head = m[1].replace(/[\s([:.-]+$/, '');
  return head ? `${head}. It did not run.` : 'The action did not run.';
}

/** The approved agent_pending_actions row as locked by the final approval. */
type ApprovedRow = {
  id: string;
  payload: PendingPayload | null;
  modified_payload: Record<string, unknown> | null;
  employee_role: string | null;
  workflow_id: string | null;
};

/**
 * Run one approved parked action. Args always come from the stored row
 * (modified_payload wins over the parked payload), never from the request.
 * This is the single switch point for the executor's approved-action entry.
 */
async function executeApproved(
  row: ApprovedRow,
  actor: { orgId: string; actorUserId: string },
  d: DecideApprovalDeps
): Promise<{
  call: { tool: string; action: string; args: Record<string, unknown> };
  executionResult: unknown;
  executionError: string | null;
}> {
  const stored = (row.payload || {}) as PendingPayload;
  const call = extractToolCall(stored, row.modified_payload);
  if (!call.tool) {
    return { call, executionResult: undefined, executionError: 'Parked payload missing tool name' };
  }
  // Only a well-formed id is passed on: the parked payload is stored data, not a trusted request.
  const employeeId = typeof stored.employeeId === 'string' && UUID_RE.test(stored.employeeId) ? stored.employeeId : undefined;
  try {
    const executionResult = await withTimeout(
      d.execute({
        tool: call.tool,
        action: call.action,
        payload: call.args,
        orgId: actor.orgId,
        actorUserId: actor.actorUserId,
        employeeRole: row.employee_role || undefined,
        ...(employeeId ? { employeeId } : {}),
        workflowId: row.workflow_id || undefined,
        skipAutonomy: true,
        approvedPendingActionId: row.id,
        source: 'approval',
      }),
      d.executeTimeoutMs
    );
    return { call, executionResult, executionError: failureOf(executionResult) };
  } catch (err) {
    return { call, executionResult: undefined, executionError: err instanceof Error ? err.message : String(err) };
  }
}

let defaultDeps: DecideApprovalDeps | null = null;
async function loadDefaultDeps(): Promise<DecideApprovalDeps> {
  if (defaultDeps) return defaultDeps;
  const mod = await import('@darex/workflows/dist/tool-executor');
  defaultDeps = {
    getClient: getOrgScopedClient,
    execute: mod.executeAutonomousToolAction as unknown as ExecuteFn,
    executeTimeoutMs: Number(process.env.DAREX_DECISION_EXECUTE_TIMEOUT_MS) || 120_000,
  };
  return defaultDeps;
}

export async function decideApproval(
  input: DecideApprovalInput,
  deps?: DecideApprovalDeps
): Promise<DecideApprovalResult> {
  const d = deps ?? (await loadDefaultDeps());
  const { pendingActionId, decision, actorUserId, orgId } = input;
  if (!UUID_RE.test(pendingActionId)) {
    return { ok: false, httpStatus: 400, error: 'Valid pendingActionId required' };
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    return { ok: false, httpStatus: 400, error: 'decision must be approved or rejected' };
  }
  const payloadErr = validateModifiedPayload(input.modifiedPayload);
  if (payloadErr) return { ok: false, httpStatus: 400, error: payloadErr };
  const modifiedPayload = input.modifiedPayload ?? null;

  const scoped = await d.getClient(orgId);
  const client = scoped.client;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      client.release();
    }
  };

  try {
    const role = await loadHumanRole(client, actorUserId);
    const existing = await client.query(
      `SELECT id, action_type, employee_role, payload, status, expires_at, token_hash,
              required_approvals, approvals, workflow_id, work_item_id
         FROM agent_pending_actions
        WHERE id = $1 AND org_id = $2`,
      [pendingActionId, orgId]
    );
    const row = existing.rows[0];
    if (!row) return { ok: false, httpStatus: 404, error: 'Decision not found' };

    if (input.token !== undefined && input.token !== null) {
      const tokenHash = createHash('sha256').update(String(input.token)).digest('hex');
      if (row.token_hash !== tokenHash) {
        return { ok: false, httpStatus: 403, error: 'invalid token' };
      }
    }

    const payload = (row.payload || {}) as PendingPayload;
    const actionType = String(row.action_type || '');
    const policyErr = approvalPolicyError(role, decision, actionType, payload);
    if (policyErr) return { ok: false, httpStatus: 403, error: policyErr };

    if (row.status !== 'pending') {
      return { ok: false, httpStatus: 409, error: `Decision already ${row.status}` };
    }
    const workItemId = (row.work_item_id as string | null) ?? null;
    const tool = String(payload.tool || '') || null;

    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      await inTx(client, async () => {
        const upd = await client.query(
          `UPDATE agent_pending_actions SET status = 'expired', decided_at = NOW()
            WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
          [pendingActionId, orgId]
        );
        if (upd.rowCount) {
          await insertAudit(client, orgId, actorUserId, 'decision.expired', 'denied', 'medium', tool,
            workItemId, { pendingActionId, source: 'decide_attempt' });
          await setWorkItemStatus(client, orgId, workItemId, 'cancelled');
        }
      });
      return { ok: false, httpStatus: 409, error: 'Decision expired — expiry never approves', id: pendingActionId };
    }

    if (decision === 'rejected') {
      const done = await inTx(client, async () => {
        const upd = await client.query(
          `UPDATE agent_pending_actions
              SET status = 'rejected', decided_at = NOW(), decided_by = $3
            WHERE id = $1 AND org_id = $2 AND status = 'pending'
            RETURNING id`,
          [pendingActionId, orgId, actorUserId]
        );
        if (!upd.rows[0]) return false;
        await insertAudit(client, orgId, actorUserId, 'decision.rejected', 'ok', 'medium', tool,
          workItemId, { pendingActionId, actionType });
        await setWorkItemStatus(client, orgId, workItemId, 'cancelled');
        return true;
      });
      if (!done) return { ok: false, httpStatus: 409, error: 'Decision already resolved' };
      return { ok: true, httpStatus: 200, id: pendingActionId, status: 'rejected' };
    }

    const refund = isRefundAction(actionType, payload);
    const requiredApprovals = Math.max(1, Number(row.required_approvals) || (refund ? 2 : 1));
    const prior: Array<{ userId: string; at: string }> = Array.isArray(row.approvals) ? row.approvals : [];
    if (prior.some((a) => a && a.userId === actorUserId)) {
      return { ok: false, httpStatus: 409, error: 'You already approved this decision' };
    }
    const nextApprovals = [...prior, { userId: actorUserId, at: new Date().toISOString() }];
    const final = nextApprovals.length >= requiredApprovals;

    const locked = await inTx(client, async () => {
      const upd = await client.query(
        `UPDATE agent_pending_actions
            SET approvals = $3::jsonb,
                required_approvals = $4,
                modified_payload = COALESCE($5::jsonb, modified_payload)
                ${final ? `, status = 'approved', decided_at = NOW(), decided_by = $6` : ''}
          WHERE id = $1 AND org_id = $2 AND status = 'pending'
            AND (expires_at IS NULL OR expires_at > NOW())
          RETURNING id, payload, modified_payload, employee_role, workflow_id, approvals`,
        [
          pendingActionId,
          orgId,
          JSON.stringify(nextApprovals),
          requiredApprovals,
          modifiedPayload ? JSON.stringify(modifiedPayload) : null,
          ...(final ? [actorUserId] : []),
        ]
      );
      const lockedRow = upd.rows[0];
      if (!lockedRow) return null;
      await insertAudit(client, orgId, actorUserId, 'decision.approved', 'ok', refund ? 'high' : 'medium',
        tool, workItemId, {
          pendingActionId,
          actionType,
          approvalsSoFar: nextApprovals.length,
          requiredApprovals,
          final,
          modified: Boolean(modifiedPayload),
        });
      return lockedRow;
    });
    if (!locked) {
      return { ok: false, httpStatus: 409, error: 'Decision already resolved or expired' };
    }

    if (!final) {
      return {
        ok: true,
        httpStatus: 200,
        id: pendingActionId,
        status: 'pending',
        awaitingApprovals: requiredApprovals - nextApprovals.length,
        approvals: locked.approvals,
      };
    }

    // Never hold a pooled client across the tool call.
    release();

    const { call, executionResult, executionError } = await executeApproved(
      { ...(locked as ApprovedRow), id: pendingActionId },
      { orgId, actorUserId },
      d
    );

    const after = await d.getClient(orgId);
    try {
      const writeOutcome = async (withAudit: boolean) => {
        if (executionError) {
          await after.client.query(
            `UPDATE agent_pending_actions
                SET status = 'execution_failed', execution_error = $3, executed_at = NOW()
              WHERE id = $1 AND org_id = $2`,
            [pendingActionId, orgId, executionError]
          );
          await setWorkItemStatus(after.client, orgId, workItemId, 'needs_attention');
          if (withAudit) {
            await insertAudit(after.client, orgId, actorUserId, 'decision.execution_failed', 'error',
              'high', call.tool || null, workItemId, { pendingActionId, error: executionError });
          }
        } else {
          await after.client.query(
            `UPDATE agent_pending_actions
                SET status = 'executed', executed_at = NOW(),
                    execution_result = $3::jsonb, execution_error = NULL
              WHERE id = $1 AND org_id = $2`,
            [pendingActionId, orgId, JSON.stringify(executionResult ?? null)]
          );
          await setWorkItemStatus(after.client, orgId, workItemId, 'done');
          if (withAudit) {
            await insertAudit(after.client, orgId, actorUserId, 'decision.approved_and_executed', 'ok',
              'high', call.tool, workItemId, { pendingActionId, tool: call.tool, action: call.action });
          }
        }
      };
      try {
        await inTx(after.client, () => writeOutcome(true));
      } catch (err) {
        if (!(err instanceof AuditWriteError)) throw err;
        // The tool already ran: record the real outcome, then fail loudly.
        await writeOutcome(false);
        console.error('[decide-approval] outcome recorded without audit row:', err.message);
        throw err;
      }
    } finally {
      after.client.release();
    }

    if (executionError) {
      return {
        ok: true,
        httpStatus: 200,
        id: pendingActionId,
        status: 'execution_failed',
        error: executionError,
      };
    }
    return { ok: true, httpStatus: 200, id: pendingActionId, status: 'executed', result: executionResult };
  } finally {
    release();
  }
}
