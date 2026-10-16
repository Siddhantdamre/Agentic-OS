import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, verifyAnswer, formatInr, ComputedValue } from './numbers.js';

const inr = (value: number): ComputedValue => ({ id: 'x', label: 'x', unit: 'inr', value });
const cnt = (value: number): ComputedValue => ({ id: 'c', label: 'c', unit: 'count', value });
const pct = (value: number): ComputedValue => ({ id: 'p', label: 'p', unit: 'percent', value });

test('extracts money in lakh, crore, k, Rs and grouped forms', () => {
  const c = extractClaims('₹12,34,567 and Rs 1.2 lakh and 2 crore and 45k and 500 rupees');
  assert.ok(c.every((x) => x.kind === 'money'));
  assert.deepEqual(c.map((x) => x.value).sort((p, q) => p - q), [500, 45000, 120000, 1234567, 2e7]);
});

test('extracts percent, count and dates', () => {
  const c = extractClaims('12.5% of 40 orders on 16 Oct 2026 and 2026-10-01');
  assert.deepEqual(c.map((x) => x.kind).sort(), ['date', 'date', 'number', 'percent']);
});

test('rounding tolerance follows the digits written', () => {
  assert.ok(verifyAnswer('₹1.2 lakh', [inr(123456)]).ok);
  assert.ok(!verifyAnswer('₹1.3 lakh', [inr(123456)]).ok);
  assert.ok(verifyAnswer('₹12,34,567', [inr(1234567)]).ok);
  assert.ok(!verifyAnswer('₹12,34,568', [inr(1234567)]).ok);
});

test('unit must match: count is not rupees', () => {
  assert.ok(!verifyAnswer('₹3', [cnt(3)]).ok);
  assert.ok(!verifyAnswer('3 lakh', [cnt(3)]).ok);
  assert.ok(verifyAnswer('3 invoices', [cnt(3)]).ok);
});

test('derived percent only allowed when computed', () => {
  assert.ok(!verifyAnswer('up 25%', [inr(100)]).ok);
  assert.ok(verifyAnswer('up 25%', [pct(25)]).ok);
  assert.ok(verifyAnswer('down 25%', [pct(-25)]).ok);
});

test('dates must come from a computed period; unmatched are listed', () => {
  const v: ComputedValue = { ...inr(5), period: { asOf: '2026-10-16' } };
  assert.ok(verifyAnswer('as of 16 Oct, ₹5', [v]).ok);
  const r = verifyAnswer('as of 17 Oct, ₹5', [v]);
  assert.equal(r.unsupported.length, 1);
  assert.equal(r.unsupported[0].kind, 'date');
});

test('formatInr uses Indian grouping', () => {
  assert.equal(formatInr(1234567), '₹12,34,567');
  assert.equal(formatInr(999), '₹999');
  assert.equal(formatInr(100000), '₹1,00,000');
  assert.equal(formatInr(1250.5), '₹1,250.50');
});

test('text without numbers is ok', () => assert.ok(verifyAnswer('Nothing to report.', []).ok));
