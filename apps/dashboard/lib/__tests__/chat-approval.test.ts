/**
 * @jest-environment node
 *
 * approveHeldCall — what allowing a call in the chat card comes to, in the words the assistant and the person see.
 */
jest.mock('@/lib/db', () => ({ getOrgScopedClient: jest.fn() }));
jest.mock('@/lib/decide-approval', () => {
  const actual = jest.requireActual('@/lib/decide-approval');
  return { ...actual, decideApproval: jest.fn() };
});

import { AuditWriteError, decideApproval } from '@/lib/decide-approval';
import { approveHeldCall } from '../chat-approval';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PA = '44444444-4444-4444-8444-444444444444';
const req = { orgId: ORG, pendingActionId: PA, approverUserId: USER };
const decide = decideApproval as jest.MockedFunction<typeof decideApproval>;

beforeEach(() => decide.mockReset());

describe('approveHeldCall', () => {
  it('approves the held row as the person who allowed it, through the one decision path, marked as from the chat', async () => {
    decide.mockResolvedValue({ ok: true, httpStatus: 200, id: PA, status: 'executed', result: { status: 'executed', message: 'Email sent', data: { id: 'm1' } } });
    const out = await approveHeldCall(req);
    expect(decide).toHaveBeenCalledWith({ pendingActionId: PA, decision: 'approved', actorUserId: USER, orgId: ORG, via: 'chat' });
    expect(out).toEqual({ status: 'executed', message: 'Email sent', data: { id: 'm1' } });
  });

  it('keeps the tool result usable when it carries no message of its own', async () => {
    decide.mockResolvedValue({ ok: true, httpStatus: 200, id: PA, status: 'executed', result: { id: 'raw-provider-answer' } });
    const out = await approveHeldCall(req);
    expect(out.status).toBe('executed');
    expect(out.message).toMatch(/approved and done/i);
  });

  it('an approval that ran and failed is failed, in the plain sentence the decision path produced', async () => {
    decide.mockResolvedValue({ ok: true, httpStatus: 200, id: PA, status: 'execution_failed', error: 'The connection was refused. It did not run.' });
    expect(await approveHeldCall(req)).toEqual({ status: 'failed', message: 'The connection was refused. It did not run.' });
  });

  it('a first approval of two is waiting, with how many are still needed', async () => {
    decide.mockResolvedValue({ ok: true, httpStatus: 200, id: PA, status: 'pending', awaitingApprovals: 1 });
    const out = await approveHeldCall(req);
    expect(out.status).toBe('waiting');
    expect(out.message).toMatch(/1 more approval/);
    expect(out.message).toMatch(/Decisions/);
  });

  it('a role that may not approve this leaves it waiting in Decisions for someone who can', async () => {
    decide.mockResolvedValue({ ok: false, httpStatus: 403, error: 'Only workspace owners and admins can approve refunds.' });
    const out = await approveHeldCall(req);
    expect(out.status).toBe('waiting');
    expect(out.message).toContain('Only workspace owners and admins can approve refunds.');
    expect(out.message).toMatch(/Decisions/);
  });

  it('a decision already made elsewhere is not run again', async () => {
    decide.mockResolvedValue({ ok: false, httpStatus: 409, error: 'Decision already executed' });
    const out = await approveHeldCall(req);
    expect(out.status).toBe('failed');
    expect(out.message).toMatch(/already/i);
  });

  it('a tool that ran but whose audit entry failed is reported as having run, never as not run', async () => {
    const err = new AuditWriteError('decision.approved_and_executed', new Error('violates check constraint'));
    err.afterExecution = true;
    decide.mockRejectedValue(err);
    const out = await approveHeldCall(req);
    expect(out.status).toBe('executed');
    expect(out.message).toMatch(/audit/i);
    expect(out.message).not.toMatch(/violates|constraint/);
  });

  it('any other failure is thrown on, so the caller can say it could not confirm, and nothing raw is returned', async () => {
    decide.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    await expect(approveHeldCall(req)).rejects.toThrow(/ECONNREFUSED/);
  });
});
