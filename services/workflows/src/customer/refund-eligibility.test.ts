import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRefundEligibility, isRefundQuery } from './refund-eligibility.js';

const NOW = '2026-01-15T00:00:00.000Z';

test('a small, recent charge is eligible', () => {
  const verdict = checkRefundEligibility({ chargeAtIso: '2026-01-10T00:00:00.000Z', amountMinor: 4999, nowIso: NOW });
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.reasonCode, 'within_policy');
});

test('a charge past the 14-day window is not eligible', () => {
  const verdict = checkRefundEligibility({ chargeAtIso: '2025-12-01T00:00:00.000Z', amountMinor: 2000, nowIso: NOW });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reasonCode, 'window_expired');
});

test('a charge over the dollar limit is not auto-eligible even if recent', () => {
  const verdict = checkRefundEligibility({ chargeAtIso: '2026-01-14T00:00:00.000Z', amountMinor: 25_000, nowIso: NOW });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reasonCode, 'amount_exceeds_limit');
});

test('invalid input never claims eligibility', () => {
  const verdict = checkRefundEligibility({ chargeAtIso: 'not-a-date', amountMinor: 100, nowIso: NOW });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.reasonCode, 'invalid_input');
});

test('isRefundQuery recognizes refund-shaped questions only', () => {
  assert.equal(isRefundQuery('Can I get a refund for last month?'), true);
  assert.equal(isRefundQuery('I want my money back'), true);
  assert.equal(isRefundQuery('What time do you close?'), false);
});
