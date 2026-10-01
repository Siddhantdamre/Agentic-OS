/**
 * @jest-environment node
 *
 * decideApproval — the single approve/reject path behind /api/decisions,
 * /api/agent/pending-actions and the inbox decision card.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

jest.mock('@/lib/db', () => ({ getOrgScopedClient: jest.fn() }));

import {
  approvalPolicyError,
  AuditWriteError,
  decideApproval,
  validateModifiedPayload,
  type DecideApprovalDeps,
} from '../decide-approval';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const PA = '44444444-4444-4444-8444-444444444444';

type Row = Record<string, unknown>;

function fakeDb(opts: { role?: string; row?: Row | null; failAuditKinds?: string[] }) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const state: Row | null = opts.row
    ? {
        id: PA,
        action_type: 'send_email',
        employee_role: 'customer',
        payload: { tool: 'gmail', action: 'send_email', payload: { to: 'a@b.c' } },
        status: 'pending',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        token_hash: createHash('sha256').update('tok').digest('hex'),
        required_approvals: 1,
        approvals: [],
        workflow_id: 'wf-1',
        work_item_id: null,
        modified_payload: null,
        ...opts.row,
      }
    : null;
  const audits: string[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: opts.role ?? 'member' }] };
    if (/^\s*SELECT id, action_type/.test(sql)) return { rows: state ? [{ ...state }] : [] };
    if (/INSERT INTO audit_events/.test(sql)) {
      const kind = String(params[1]);
      if (opts.failAuditKinds?.includes(kind)) throw new Error('violates check constraint audit_events_kind_chk');
      audits.push(kind);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE agent_pending_actions/.test(sql) && /RETURNING/.test(sql)) {
      if (!state || state.status !== 'pending') return { rows: [], rowCount: 0 };
      if (/status = 'rejected'/.test(sql)) state.status = 'rejected';
      else if (/status = 'approved'/.test(sql)) state.status = 'approved';
      if (/approvals = /.test(sql)) state.approvals = JSON.parse(String(params[2]));
      if (/modified_payload = COALESCE/.test(sql) && params[4]) state.modified_payload = JSON.parse(String(params[4]));
      return { rows: [{ ...state }], rowCount: 1 };
    }
    if (/UPDATE agent_pending_actions/.test(sql)) {
      if (state && /'executed'/.test(sql)) state.status = 'executed';
      if (state && /'execution_failed'/.test(sql)) state.status = 'execution_failed';
      if (state && /'expired'/.test(sql)) state.status = 'expired';
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  return { client, calls, audits, state };
}

function deps(db: ReturnType<typeof fakeDb>, execute = jest.fn(async () => ({ status: 'executed' }))) {
  const d: DecideApprovalDeps = {
    getClient: async () => ({ client: db.client, orgId: ORG }),
    execute,
    executeTimeoutMs: 1000,
  };
  return { d, execute };
}

describe('approvalPolicyError', () => {
  it('blocks auditor and billing from deciding', () => {
    expect(approvalPolicyError('auditor', 'approved', 'send_email', {})).toBe('Forbidden');
    expect(approvalPolicyError('billing', 'rejected', 'send_email', {})).toBe('Forbidden');
  });
  it('refunds need owner/admin; pay tools need a pay-capable role', () => {
    expect(approvalPolicyError('member', 'approved', 'refund', {})).toMatch(/refunds/);
    expect(approvalPolicyError('admin', 'approved', 'refund', {})).toBeNull();
    expect(approvalPolicyError('member', 'rejected', 'refund', {})).toBeNull();
  });
});

describe('validateModifiedPayload', () => {
  it('rejects arrays and oversized payloads', () => {
    expect(validateModifiedPayload([1])).toMatch(/object/);
    expect(validateModifiedPayload({ big: 'x'.repeat(20_000) })).toMatch(/exceeds/);
    expect(validateModifiedPayload({ to: 'a@b.c' })).toBeNull();
    expect(validateModifiedPayload(undefined)).toBeNull();
  });
});

describe('decideApproval', () => {
  it('approve executes the parked tool and writes approved + executed audit rows', async () => {
    const db = fakeDb({ row: {} });
    const { d, execute } = deps(db);
    const res = await decideApproval({ pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG }, d);
    expect(res).toMatchObject({ ok: true, status: 'executed' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tool: 'gmail', skipAutonomy: true, orgId: ORG }));
    expect(db.audits).toEqual(['decision.approved', 'decision.approved_and_executed']);
  });

  it('executes the stored modified_payload from the row', async () => {
    const db = fakeDb({ row: {} });
    const { d, execute } = deps(db);
    await decideApproval(
      { pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG, modifiedPayload: { to: 'x@y.z' } },
      d
    );
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ payload: { to: 'x@y.z' } }));
  });

  it('auditor gets 403 and nothing executes', async () => {
    const db = fakeDb({ row: {}, role: 'auditor' });
    const { d, execute } = deps(db);
    const res = await decideApproval({ pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG }, d);
    expect(res).toMatchObject({ ok: false, httpStatus: 403 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('dual approval: first approval stays pending, same user cannot approve twice', async () => {
    const db = fakeDb({ row: { required_approvals: 2 } });
    const { d, execute } = deps(db);
    const first = await decideApproval({ pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG }, d);
    expect(first).toMatchObject({ ok: true, status: 'pending', awaitingApprovals: 1 });
    const again = await decideApproval({ pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG }, d);
    expect(again).toMatchObject({ ok: false, httpStatus: 409 });
    const second = await decideApproval({ pendingActionId: PA, decision: 'approved', actorUserId: OTHER, orgId: ORG }, d);
    expect(second).toMatchObject({ ok: true, status: 'executed' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('wrong token is rejected before any state change', async () => {
    const db = fakeDb({ row: {} });
    const { d } = deps(db);
    const res = await decideApproval(
      { pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG, token: 'nope' },
      d
    );
    expect(res).toMatchObject({ ok: false, httpStatus: 403, error: 'invalid token' });
    expect(db.calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  it('expired decision never approves and is audited as expired', async () => {
    const db = fakeDb({ row: { expires_at: new Date(Date.now() - 1000).toISOString() } });
    const { d, execute } = deps(db);
    const res = await decideApproval({ pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG }, d);
    expect(res).toMatchObject({ ok: false, httpStatus: 409 });
    expect(execute).not.toHaveBeenCalled();
    expect(db.audits).toEqual(['decision.expired']);
  });

  it('audit CHECK failure on reject fails loud and rolls back', async () => {
    const db = fakeDb({ row: {}, failAuditKinds: ['decision.rejected'] });
    const { d } = deps(db);
    await expect(
      decideApproval({ pendingActionId: PA, decision: 'rejected', actorUserId: USER, orgId: ORG }, d)
    ).rejects.toBeInstanceOf(AuditWriteError);
    expect(db.calls.map((c) => c.sql)).toContain('ROLLBACK');
  });

  it('tool failure marks execution_failed with an audit row', async () => {
    const db = fakeDb({ row: {} });
    const { d } = deps(db, jest.fn(async () => { throw new Error('gmail 401'); }));
    const res = await decideApproval({ pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG }, d);
    expect(res).toMatchObject({ ok: true, status: 'execution_failed', error: 'gmail 401' });
    expect(db.audits).toEqual(['decision.approved', 'decision.execution_failed']);
  });
});
