import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  costPerObligation,
  dailySpendBreached,
  defaultCostCeiling,
  orgSweepJitterMs,
  shouldAbortTrigger,
  sweepShare,
  turnSpendCents,
} from './budget.js';

test('trigger aborts at 8 model calls', () => {
  assert.equal(shouldAbortTrigger(7), false);
  assert.equal(shouldAbortTrigger(8), true);
});

test('idle sweep share is zero when no model calls happened', () => {
  assert.equal(sweepShare(0, 0), 0);
});

test('cost per obligation is undefined when none extracted', () => {
  assert.equal(costPerObligation(40, 0), null);
  assert.equal(costPerObligation(40, 4), 10);
});

test('jitter is stable per org', () => {
  assert.equal(orgSweepJitterMs('org-a', 900000), orgSweepJitterMs('org-a', 900000));
});

test('daily spend breach', () => {
  const c = defaultCostCeiling();
  assert.equal(dailySpendBreached(c.maxSpendCentsPerDay, c), true);
});

test('turn spend prefers runtime cost, else prices tokens, else zero', () => {
  assert.equal(turnSpendCents(undefined), 0);
  assert.equal(turnSpendCents({}), 0);
  assert.equal(turnSpendCents({ totalCostInUsd: 0.0123, totalTokens: 999 }), 1.23);
  // 2M tokens at $0.50/Mtok = $1.00 = 100 cents
  assert.equal(turnSpendCents({ totalTokens: 2_000_000 }), 100);
  assert.equal(turnSpendCents({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 1), 200);
  assert.equal(turnSpendCents({ totalTokens: 1000, totalCostInUsd: 0 }), 0.05);
  assert.equal(turnSpendCents({ totalTokens: -5 }), 0);
});
