/**
 * Attribution tests.
 *
 * These are guardrails against the ledger becoming flattering. Each test names
 * the specific way an outcome-analytics system inflates its own numbers, and
 * asserts we do not do it. If one of these ever needs "relaxing", that is the
 * moment the product stops being trustworthy.
 *
 * Run: node --test dist/outcomes/attribution.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  assignArm,
  attributeOutcomes,
  summarize,
  isNegativeOutcome,
  DEFAULT_WINDOW_SECONDS,
  type AgentActionInput,
  type OutcomeEventInput,
} from './attribution';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const mins = (n: number) => n * 60_000;

function action(over: Partial<AgentActionInput> & { id: string }): AgentActionInput {
  return {
    conversationId: 'conv-1',
    actionKind: 'reply_sent',
    occurredAt: T0,
    ...over,
  };
}
function outcome(over: Partial<OutcomeEventInput> & { id: string }): OutcomeEventInput {
  return {
    conversationId: 'conv-1',
    outcomeKind: 'customer_replied',
    occurredAt: T0 + mins(5),
    ...over,
  };
}

const WINDOW = { windowSeconds: DEFAULT_WINDOW_SECONDS };

test('attributes a direct customer reply as strong', () => {
  const edges = attributeOutcomes([action({ id: 'a1' })], [outcome({ id: 'o1' })], WINDOW);
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].method, 'direct_reply');
  assert.strictEqual(edges[0].strength, 'strong');
  assert.strictEqual(edges[0].latencySeconds, 300);
  assert.strictEqual(edges[0].windowSeconds, DEFAULT_WINDOW_SECONDS);
});

test('an outcome is credited to at most one action (no double counting)', () => {
  // Three replies then one customer response. A naive implementation credits
  // all three and reports 3 wins from 1 real event.
  const actions = [
    action({ id: 'a1', occurredAt: T0 }),
    action({ id: 'a2', occurredAt: T0 + mins(1) }),
    action({ id: 'a3', occurredAt: T0 + mins(2) }),
  ];
  const edges = attributeOutcomes(actions, [outcome({ id: 'o1' })], WINDOW);
  assert.strictEqual(edges.length, 1, 'exactly one edge per outcome');
  assert.strictEqual(edges[0].actionId, 'a3', 'last touch wins');
});

test('outcomes before the action are never attributed', () => {
  // Guards against the ledger claiming credit for something that already
  // happened before the agent did anything.
  const edges = attributeOutcomes(
    [action({ id: 'a1', occurredAt: T0 })],
    [outcome({ id: 'o1', occurredAt: T0 - mins(5) })],
    WINDOW
  );
  assert.deepStrictEqual(edges, []);
});

test('simultaneous timestamps are not attributed', () => {
  // Same instant cannot be ordered; guessing would manufacture credit.
  const edges = attributeOutcomes(
    [action({ id: 'a1', occurredAt: T0 })],
    [outcome({ id: 'o1', occurredAt: T0 })],
    WINDOW
  );
  assert.deepStrictEqual(edges, []);
});

test('outcomes outside the window are not attributed', () => {
  const edges = attributeOutcomes(
    [action({ id: 'a1', occurredAt: T0 })],
    [outcome({ id: 'o1', occurredAt: T0 + mins(60) })],
    { windowSeconds: 1800 } // 30 min
  );
  assert.deepStrictEqual(edges, []);
});

test('window boundary is inclusive and deterministic', () => {
  const edges = attributeOutcomes(
    [action({ id: 'a1', occurredAt: T0 })],
    [outcome({ id: 'o1', occurredAt: T0 + mins(30) })],
    { windowSeconds: 1800 }
  );
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].latencySeconds, 1800);
});

test('cross-conversation attribution is refused unless weak is enabled', () => {
  const a = [action({ id: 'a1', conversationId: 'conv-A' })];
  const o = [outcome({ id: 'o1', conversationId: 'conv-B', outcomeKind: 'deal_closed' })];

  assert.deepStrictEqual(attributeOutcomes(a, o, WINDOW), [], 'off by default');

  const weak = attributeOutcomes(a, o, { ...WINDOW, allowWeak: true });
  assert.strictEqual(weak.length, 1);
  assert.strictEqual(weak[0].method, 'temporal_proximity');
  assert.strictEqual(weak[0].strength, 'weak', 'must stay labelled weak');
});

test('same-conversation non-reply outcomes are moderate, not strong', () => {
  // A booked meeting may owe as much to a phone call as to this message.
  const edges = attributeOutcomes(
    [action({ id: 'a1' })],
    [outcome({ id: 'o1', outcomeKind: 'meeting_booked' })],
    WINDOW
  );
  assert.strictEqual(edges[0].method, 'same_conversation');
  assert.strictEqual(edges[0].strength, 'moderate');
});

test('intervening agent actions downgrade strong to moderate', () => {
  const actions = [
    action({ id: 'a1', occurredAt: T0 }),
    action({ id: 'a2', occurredAt: T0 + mins(1), actionKind: 'tool_executed' }),
  ];
  // Last touch is the tool call, not a reply → cannot be a direct reply.
  const edges = attributeOutcomes(actions, [outcome({ id: 'o1' })], WINDOW);
  assert.strictEqual(edges[0].actionId, 'a2');
  assert.strictEqual(edges[0].strength, 'moderate');
});

test('negative outcomes are attributed and flagged, never dropped', () => {
  // Hiding failures is the fastest way to make the ledger worthless.
  const edges = attributeOutcomes(
    [action({ id: 'a1' })],
    [outcome({ id: 'o1', outcomeKind: 'human_took_over' })],
    WINDOW
  );
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].evidence.negativeOutcome, true);
  assert.ok(isNegativeOutcome('feedback_negative'));
  assert.ok(!isNegativeOutcome('deal_closed'));
});

test('result is independent of input ordering', () => {
  const actions = [
    action({ id: 'a3', occurredAt: T0 + mins(2) }),
    action({ id: 'a1', occurredAt: T0 }),
    action({ id: 'a2', occurredAt: T0 + mins(1) }),
  ];
  const forward = attributeOutcomes(actions, [outcome({ id: 'o1' })], WINDOW);
  const reversed = attributeOutcomes([...actions].reverse(), [outcome({ id: 'o1' })], WINDOW);
  assert.deepStrictEqual(forward, reversed);
});

test('summarize counts unattributed actions in the denominator', () => {
  // Reporting only over attributed pairs would show a 100% success rate here.
  const actions = [
    action({ id: 'a1', occurredAt: T0 }),
    action({ id: 'a2', occurredAt: T0 + mins(1), conversationId: 'conv-quiet' }),
    action({ id: 'a3', occurredAt: T0 + mins(2), conversationId: 'conv-quiet2' }),
  ];
  const edges = attributeOutcomes(actions, [outcome({ id: 'o1' })], WINDOW);
  const s = summarize(actions, edges);

  assert.strictEqual(s.totalActions, 3);
  assert.strictEqual(s.attributedActions, 1);
  assert.strictEqual(s.unattributedActions, 2);
  assert.ok(Math.abs(s.attributionRate - 1 / 3) < 1e-9, 'rate is over ALL actions');
});

test('summarize on an empty ledger reports zero, not NaN', () => {
  const s = summarize([], []);
  assert.strictEqual(s.attributionRate, 0);
  assert.strictEqual(s.totalActions, 0);
});

test('invalid window is rejected rather than silently defaulted', () => {
  assert.throws(() => attributeOutcomes([], [], { windowSeconds: 0 }), /positive/);
  assert.throws(() => attributeOutcomes([], [], { windowSeconds: -1 }), /positive/);
  assert.throws(
    () => attributeOutcomes([], [], { windowSeconds: Number.NaN }),
    /positive/
  );
});

test('arm assignment is deterministic and stable', () => {
  const a = assignArm('conv-1', 'exp-a', 20);
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(assignArm('conv-1', 'exp-a', 20), a, 'must not vary between calls');
  }
});

test('arm assignment is independent across experiments', () => {
  // Two experiments must not inherit the same split, or their results correlate.
  let differs = false;
  for (let i = 0; i < 200; i++) {
    if (assignArm(`conv-${i}`, 'exp-a', 50) !== assignArm(`conv-${i}`, 'exp-b', 50)) {
      differs = true;
      break;
    }
  }
  assert.ok(differs, 'experiment key must change the assignment');
});

test('holdout percentage is approximately honoured', () => {
  const N = 4000;
  let holdouts = 0;
  for (let i = 0; i < N; i++) {
    if (assignArm(`conv-${i}`, 'exp-split', 20) === 'holdout') holdouts += 1;
  }
  const pct = (holdouts / N) * 100;
  assert.ok(pct > 17 && pct < 23, `expected ~20% holdout, got ${pct.toFixed(1)}%`);
});

test('holdout extremes disable or force the control arm', () => {
  assert.strictEqual(assignArm('conv-1', 'e', 0), 'treatment', '0% = no control group');
  assert.strictEqual(assignArm('conv-1', 'e', 100), 'holdout');
});
