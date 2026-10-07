import test from 'node:test';
import assert from 'node:assert/strict';
import type { GateParams, GateResult } from './tool-gate.js';
import type { ChatApprovalContext, ParkedApprovalRequest } from './chat-approval.js';
import { DarexLocalToolSet, newLocalTurnBudget, approvalRequestFor, rememberToolCalls } from './local-turn.js';
import { TOOLS } from './tool-definitions.js';

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

// Allowing a call in the chat card IS the approval, so the card has to show what is being approved. It used to say
// only "Tool Approval Required for gmail_send".
test('the card for a pending send says what it would do and carries the call itself', () => {
  const ref = { threadId: 't1', toolCallId: 'c1', toolName: 'gmail_send' };
  const req = approvalRequestFor(TOOLS, ref, JSON.stringify({ org_id: 'x', ...SEND_ARGS }));
  assert.equal(req.threadId, 't1');
  assert.equal(req.toolCallId, 'c1');
  assert.equal(req.summary, 'Send email "Your viewing" to priya@example.test');
  assert.deepEqual(req.call, { tool: 'gmail', action: 'send_email', args: SEND_ARGS }, 'org_id is never model-supplied and is not shown');
});

test('a call with arguments that cannot be read, or an unknown tool, still gets a plain card', () => {
  const ref = { threadId: 't1', toolCallId: 'c1', toolName: 'gmail_send' };
  assert.deepEqual(approvalRequestFor(TOOLS, ref, '{not json'), ref);
  assert.deepEqual(approvalRequestFor(TOOLS, { ...ref, toolName: 'no_such_tool' }, '{}'), { ...ref, toolName: 'no_such_tool' });
  assert.deepEqual(approvalRequestFor(TOOLS, ref, undefined), ref, 'no arguments seen: nothing invented');
});

test('a very long message is cut before it is sent to the browser', () => {
  const req = approvalRequestFor(TOOLS, { threadId: 't', toolCallId: 'c', toolName: 'gmail_send' }, { ...SEND_ARGS, body: 'x'.repeat(20000) });
  const body = (req.call?.args as { body: string }).body;
  assert.ok(body.length <= 4001);
  assert.ok(body.endsWith('…'));
});

// The model streams a call's arguments in pieces: the first fragment has the id and name and empty arguments, and the
// JSON arrives in a later fragment that carries only the call's index. A card made from the first fragment alone would
// be empty.
test('arguments are put together from the streamed fragments, in order, by call index', () => {
  const names = new Map<string, string>();
  const args = new Map<string, unknown>();
  const ix = new Map<number, string>();
  const json = JSON.stringify(SEND_ARGS);
  rememberToolCalls({ type: 'model.message.delta', tool_calls: [{ index: 0, id: 'c1', function: { name: 'gmail_send', arguments: '' } }] }, names, args, ix);
  rememberToolCalls({ type: 'model.message.delta', tool_calls: [{ index: 0, function: { arguments: json.slice(0, 20) } }] }, names, args, ix);
  rememberToolCalls({ type: 'model.message.delta', tool_calls: [{ index: 0, function: { arguments: json.slice(20) } }] }, names, args, ix);
  assert.equal(names.get('c1'), 'gmail_send');
  assert.equal(args.get('c1'), json);
  const req = approvalRequestFor(TOOLS, { threadId: 't', toolCallId: 'c1', toolName: names.get('c1')! }, args.get('c1'));
  assert.equal(req.summary, 'Send email "Your viewing" to priya@example.test');
});

test('two calls in one message keep their own arguments', () => {
  const names = new Map<string, string>();
  const args = new Map<string, unknown>();
  const ix = new Map<number, string>();
  rememberToolCalls({ type: 'model.message.delta', tool_calls: [{ index: 0, id: 'a', function: { name: 'gmail_send', arguments: '{"to":"a@x.co"' } }, { index: 1, id: 'b', function: { name: 'gmail_send', arguments: '{"to":"b@x.co"' } }] }, names, args, ix);
  rememberToolCalls({ type: 'model.message.delta', tool_calls: [{ index: 1, function: { arguments: '}' } }, { index: 0, function: { arguments: '}' } }] }, names, args, ix);
  assert.equal(args.get('a'), '{"to":"a@x.co"}');
  assert.equal(args.get('b'), '{"to":"b@x.co"}');
});

test('a complete model message sets the arguments as they are, and a new message starts the numbering again', () => {
  const names = new Map<string, string>();
  const args = new Map<string, unknown>();
  const ix = new Map<number, string>();
  rememberToolCalls({ type: 'model.message', tool_calls: [{ index: 0, id: 'c9', function: { name: 'gmail_send', arguments: JSON.stringify(SEND_ARGS) } }] }, names, args, ix);
  assert.equal(args.get('c9'), JSON.stringify(SEND_ARGS));
  rememberToolCalls({ type: 'model.message', tool_calls: null as unknown as unknown[] }, names, args, ix);
  assert.equal(ix.size, 0, 'a new model message forgets the previous message\'s indexes');
});

test('events that are not about tool calls are ignored', () => {
  const names = new Map<string, string>();
  const args = new Map<string, unknown>();
  const ix = new Map<number, string>();
  rememberToolCalls({ type: 'tool.response' }, names, args, ix);
  rememberToolCalls({ type: 'model.message.delta', tool_calls: 'nope' as unknown as unknown[] }, names, args, ix);
  rememberToolCalls({ type: 'model.message.delta', tool_calls: [{ function: { arguments: '{}' } }] }, names, args, ix);
  assert.equal(names.size + args.size, 0);
});
