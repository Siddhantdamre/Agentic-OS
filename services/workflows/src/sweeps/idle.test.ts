import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessSweepDueCount, capSweepActions, SWEEP_ACTION_CAP } from './idle.js';

test('idle sweep makes zero model calls when nothing is due', () => {
  const r = assessSweepDueCount('open_loops', 0);
  assert.equal(r.idle, true);
  assert.equal(r.modelCalls, 0);
});

test('sweep action cap defers the remainder', () => {
  const { take, defer } = capSweepActions(80);
  assert.equal(take, SWEEP_ACTION_CAP);
  assert.equal(defer, 30);
});
