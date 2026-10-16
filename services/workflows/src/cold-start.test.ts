import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backfillLoopStatus, coldStartPhase, coldStartPolicy, seedColdStart } from './cold-start.js';

test('week-one orgs notice only and never chase backfill', () => {
  const p = coldStartPolicy(2);
  assert.equal(p.phase, 'notice');
  assert.equal(p.externalSendsEnabled, false);
  assert.equal(p.backfillChases, false);
  assert.equal(backfillLoopStatus(false), 'closed');
});

test('notice then draft then internal then external', () => {
  assert.equal(coldStartPhase(0), 'notice');
  assert.equal(coldStartPhase(7), 'draft');
  assert.equal(coldStartPhase(14), 'act_internal');
  assert.equal(coldStartPhase(21), 'act_external');
  assert.equal(coldStartPolicy(16).autonomyEnabled, true);
  assert.equal(coldStartPolicy(16).externalSendsEnabled, false);
});

test('seedColdStart returns day 0 notice-only policy by default', () => {
  const initial = seedColdStart();
  assert.equal(initial.phase, 'notice');
  assert.equal(initial.autonomyEnabled, false);
  assert.equal(initial.externalSendsEnabled, false);
  assert.equal(initial.maxOutboundPerCustomerDay, 0);
});
