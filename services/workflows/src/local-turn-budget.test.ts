import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DarexLocalToolSet,
  LOCAL_TURN_MAX_TOOL_CALLS,
  newLocalTurnBudget,
  readCallKey,
  sideEffectStopResult,
} from './local-turn.js';
import { TOOLS } from './tool-definitions.js';
import { resolveToolRisk } from './tools/index.js';

const ORG = '00000000-0000-4000-8000-0000000000b8';

function textOf(res: unknown): string {
  const r = res as { content?: Array<{ text?: string }>; text?: string };
  if (Array.isArray(r?.content)) return r.content.map((c) => c.text || '').join('');
  return JSON.stringify(res);
}

test('tool calls past the per-turn cap are refused without executing', async () => {
  const budget = newLocalTurnBudget();
  budget.toolCalls = LOCAL_TURN_MAX_TOOL_CALLS;
  const controller = new AbortController();
  budget.controller = controller;
  const set = new DarexLocalToolSet(ORG, undefined, ['gmail'], undefined, 'send an email', budget);
  const res = await set.callTool({
    name: 'gmail_send',
    arguments: { to: 'a@b.co', subject: 'Hi', body: 'x' },
  });
  assert.match(textOf(res), /Tool-call limit/);
  assert.equal(budget.sideEffects.length, 0, 'refused call must not count as a side effect');
  assert.equal(controller.signal.aborted, false);

  for (let i = 0; i < 3; i += 1) await set.callTool({ name: 'gmail_send', arguments: { to: 'a@b.co', subject: 'Hi', body: 'x' } });
  assert.equal(controller.signal.aborted, true, 'persistent over-cap calls stop the turn');
});

test('invalid args are refused before they count against the budget', async () => {
  const budget = newLocalTurnBudget();
  const set = new DarexLocalToolSet(ORG, undefined, ['gmail'], undefined, 'send an email', budget);
  const res = await set.callTool({ name: 'gmail_send', arguments: '{not json' });
  assert.match(textOf(res), /not valid JSON/);
  assert.equal(budget.toolCalls, 0);
  assert.equal(budget.sideEffects.length, 0);
});

test('a failed turn after a side effect returns a non-empty stop result', () => {
  const budget = newLocalTurnBudget();
  budget.sideEffects.push('gmail_send', 'gmail_send');
  const res = sideEffectStopResult(budget, { model: 'm' }, Date.now());
  // runTrueForgeTurn returns any local result with tools, so the HTTP path
  // never replays the turn.
  assert.ok(res.tools.length > 0);
  assert.equal(res.tools.length, 1, 'deduped by tool name');
  assert.match(res.reply, /did not retry/);
});

test('an identical read-only call in one turn reuses the earlier result and costs no budget', async () => {
  const def = TOOLS.find((t) => t.name === 'metrics_list');
  assert.ok(def, 'metrics_list tool exists');
  assert.equal(resolveToolRisk(def.tool, def.action)?.risk, 'read');
  const budget = newLocalTurnBudget();
  const sentinel = { content: [{ type: 'text', text: 'cached-metrics' }] };
  budget.readResults = new Map([[readCallKey(def.tool, def.action, {}), sentinel]]);
  const set = new DarexLocalToolSet(ORG, undefined, [def.tool], undefined, 'metrics', budget);
  const res = await set.callTool({ name: 'metrics_list', arguments: {} });
  assert.equal(res, sentinel);
  assert.equal(budget.toolCalls, 0);
  assert.equal(budget.sideEffects.length, 0);
});
