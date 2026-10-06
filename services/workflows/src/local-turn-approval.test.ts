import test from 'node:test';
import assert from 'node:assert/strict';
import { DarexLocalToolSet, newLocalTurnBudget } from './local-turn.js';

const ORG = '00000000-0000-4000-8000-0000000000c9';
const SEND_ARGS = { to: 'priya@example.test', subject: 'Your viewing', body: 'Confirmed for 5pm' };

type ToolResponse = { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
const textOf = (res: unknown) => ((res as ToolResponse).result?.content ?? []).map((c) => c.text || '').join('');

test('a call the person denied in the chat card is never run', async () => {
  const budget = newLocalTurnBudget();
  const set = new DarexLocalToolSet(ORG, undefined, ['gmail'], undefined, 'send an email', budget);
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'deny', reason: 'not now' });
  assert.equal((res as ToolResponse).result?.isError, true);
  assert.match(textOf(res), /denied/i);
  assert.match(textOf(res), /not now/);
  // It stopped before the budget and before the gate: nothing was counted and nothing was dispatched.
  assert.equal(budget.toolCalls, 0);
  assert.deepEqual(budget.sideEffects, []);
});

test('a denied call with no reason still says it was not run', async () => {
  const set = new DarexLocalToolSet(ORG, undefined, ['gmail'], undefined, 'send an email', newLocalTurnBudget());
  const res = await set.callTool({ name: 'gmail_send', arguments: SEND_ARGS }, { status: 'deny' });
  assert.match(textOf(res), /was not run\./);
});
