import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareExpectation,
  discrepancyCardPayload,
  findExpectationRule,
  inferredDeadline,
  OPERATIONAL_EXPECTATION_RULES,
} from './expected-vs-actual-engine.js';

test('settled on time is not a discrepancy', () => {
  const cmp = compareExpectation({
    expectedState: 'contacted',
    actualState: 'contacted',
    expectedBy: new Date('2026-09-20T11:00:00Z'),
    now: new Date('2026-09-20T12:00:00Z'),
  });
  assert.equal(cmp.isDiscrepancy, false);
  assert.equal(cmp.magnitude, 'met on time');
});

test('missed expectation names expected, actual, and the numeric gap', () => {
  const cmp = compareExpectation({
    expectedState: 'contacted',
    actualState: 'assigned',
    expectedBy: new Date('2026-09-20T12:00:00Z'),
    now: new Date('2026-09-20T14:00:00Z'),
  });
  assert.equal(cmp.isDiscrepancy, true);
  const card = discrepancyCardPayload(cmp, 'enquiry', 'e1');
  assert.equal(card.expected, 'contacted');
  assert.equal(card.actual, 'assigned');
  assert.equal(card.overdueHours, 2);
  assert.match(card.gap, /2\.0h late/);
});

test('inferred deadline uses the 80th percentile, not the mean', () => {
  assert.equal(inferredDeadline([1, 2, 3, 4, 100], 48), 4);
});

test('hot lead rule requires contact within 2 hours of assignment', () => {
  const rule = findExpectationRule('hot_lead_contacted_within_2h');
  assert.ok(rule);
  assert.equal(rule?.objectType, 'enquiry');
  assert.equal(rule?.expectedState, 'contacted');
  assert.equal(rule?.slaMs, 2 * 60 * 60 * 1000);
});

test('duplicate-contact rule has zero grace period', () => {
  const rule = findExpectationRule('contact_no_duplicate');
  assert.ok(rule);
  assert.equal(rule?.slaMs, 0);
});

test('unknown rule name resolves to undefined', () => {
  assert.equal(findExpectationRule('does_not_exist'), undefined);
});

test('every registered rule has a unique name', () => {
  const names = OPERATIONAL_EXPECTATION_RULES.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
});
