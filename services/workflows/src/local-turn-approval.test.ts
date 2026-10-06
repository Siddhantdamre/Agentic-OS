import test from 'node:test';
import assert from 'node:assert/strict';
import type { GateParams, GateResult } from './tool-gate.js';
import type { ChatApprovalContext, ParkedApprovalRequest } from './chat-approval.js';
import { DarexLocalToolSet, newLocalTurnBudget } from './local-turn.js';

const ORG = '00000000-0000-4000-8000-0000000000c9';
const SEND_ARGS = { to: 'priya@example.test', subject: 'Your viewing', body: 'Confirmed for 5pm' };
const HELD: GateResult = {
  tool: 'gmail', action: 'send_email', status: 'pending_approval', message: 'Waiting for approval: Send email',
  data: { pendingActionId: '11111111-1111-4111-8111-111111111111' },
  approval: { pendingActionId: '11111111-1111-4111-8111-111111111111', workItemId: null, summary: 'Send email' },
  timestamp: new Date().toISOString(),
};

type ToolResponse = { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
function textOf(res: unknown): string {
  const content = (res as ToolResponse)?.result?.content;
  return Array.isArray(content) ? content.map((c) => c.text || '').join('') : JSON.stringify(res);
}
function body(res: unknown): { status: string; message: string; data?: unknown } {
  const t = textOf(res);
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}

/** The tool set with the gate and the announcement replaced, so no database or provider is touched. */
class Probe extends DarexLocalToolSet {
  gateCalls: GateParams[] = [];
  announced: string[] = [];
  gateResult: GateResult = HELD;
  protected override async runGate(params: GateParams): Promise<GateResult> {
    this.gateCalls.push(params);
    return this.gateResult;
  }
  protected override async announceHold(_orgId: string, pendingActionId: string): Promise<void> {
    this.announced.push(pendingActionId);
  }
}
function probe(chat?: ChatApprovalContext) {
  return new Probe(ORG, undefined, ['gmail'], undefined, 'send an email', newLocalTurnBudget(), chat);
}

test('a denied call is never run and never reaches the gate', async () => {
  const set = probe({ approverUserId: 'u1', approveParked: async () => { throw new Error('must not be asked'); } });
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'deny', reason: 'not now' });
  assert.equal(set.gateCalls.length, 0, 'the gate must not be called for a call the person denied');
  assert.match(textOf(res), /denied/i);
  assert.match(textOf(res), /not now/);
  assert.equal((res as ToolResponse).result?.isError, true);
});

test('a denied call with no reason still says it was not run', async () => {
  const set = probe({});
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'deny' });
  assert.match(textOf(res), /was not run\./);
  assert.equal(set.gateCalls.length, 0);
});

test('an allowed call that the gate holds is approved on the spot by the person who allowed it, and runs once', async () => {
  const requests: ParkedApprovalRequest[] = [];
  const set = probe({
    approverUserId: 'user-7',
    approveParked: async (req) => { requests.push(req); return { status: 'executed', message: 'Email sent', data: { id: 'm1' } }; },
  });
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'allow' });
  assert.equal(set.gateCalls.length, 1);
  assert.equal(set.gateCalls[0].approverPresent, true, 'a hold made for an allowed call is not announced to managers');
  assert.deepEqual(requests, [{ orgId: ORG, pendingActionId: HELD.approval!.pendingActionId!, approverUserId: 'user-7' }]);
  assert.equal(body(res).status, 'executed');
  assert.deepEqual(set.announced, []);
});

test('a call with no decision is never approved for the person, even when a resume is in progress', async () => {
  let asked = 0;
  const set = probe({ approverUserId: 'user-7', approveParked: async () => { asked += 1; return { status: 'executed', message: 'x' }; } });
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS });
  assert.equal(asked, 0);
  assert.equal(set.gateCalls[0].approverPresent, undefined);
  assert.equal(body(res).status, 'pending_approval');
});

test('an allow with no approver known (no authenticated resume) leaves the hold for Decisions', async () => {
  const set = probe({});
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'allow' });
  assert.equal(body(res).status, 'pending_approval');
  assert.equal(set.gateCalls[0].approverPresent, undefined);
});

test('a hold that needs another person is announced to managers and reported as waiting, not as done', async () => {
  const set = probe({ approverUserId: 'user-7', approveParked: async () => ({ status: 'waiting', message: 'You approved it. It needs 1 more approval.' }) });
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'allow' });
  assert.equal(body(res).status, 'pending_approval');
  assert.deepEqual(set.announced, [HELD.approval!.pendingActionId]);
});

test('if recording the approval throws, nothing is claimed as sent and the hold is announced', async () => {
  const set = probe({ approverUserId: 'user-7', approveParked: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } });
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'allow' });
  const b = body(res);
  assert.notEqual(b.status, 'executed');
  assert.doesNotMatch(textOf(res), /ECONNREFUSED|10\.0\.0\.5/);
  assert.match(b.message, /Decisions/);
  assert.deepEqual(set.announced, [HELD.approval!.pendingActionId]);
});

test('an allowed call the gate runs straight away or refuses is returned as the gate said it', async () => {
  const set = probe({ approverUserId: 'user-7', approveParked: async () => { throw new Error('must not be asked'); } });
  set.gateResult = { tool: 'gmail', action: 'send_email', status: 'error', reason: 'shadow', message: 'Watching mode: I recorded it but did not run it.', data: null, timestamp: new Date().toISOString() };
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'allow' });
  assert.equal(body(res).status, 'error');
  assert.match(textOf(res), /Watching mode/);
});
