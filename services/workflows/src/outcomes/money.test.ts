/**
 * Money arithmetic.
 *
 * This is the number a business will quote back at renewal, so every case
 * below is one where getting it wrong would be flattering — which is the
 * direction mistakes in revenue reporting always go.
 *
 * Run: node --test dist/outcomes/money.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  summariseMoney,
  autonomousValuePct,
  type ValueOutcomeRow,
} from './money';

const row = (over: Partial<ValueOutcomeRow> = {}): ValueOutcomeRow => ({
  kind: 'payment_received',
  amount: 1000,
  currency: 'INR',
  humanInvolved: false,
  ...over,
});

// ── The basic split ─────────────────────────────────────────────────────────

test('value is split by whether a person was involved', () => {
  const s = summariseMoney([
    row({ amount: 300000 }),
    row({ amount: 120000 }),
    row({ amount: 80000, humanInvolved: true }),
  ]);
  const inr = s.byCurrency[0];
  assert.equal(inr.currency, 'INR');
  assert.equal(inr.withoutHuman, 420000);
  assert.equal(inr.withHuman, 80000);
  assert.equal(inr.total, 500000);
});

test('each kind is counted separately', () => {
  const s = summariseMoney([
    row({ kind: 'meeting_booked', amount: null, currency: null }),
    row({ kind: 'meeting_booked', amount: null, currency: null }),
    row({ kind: 'payment_received', amount: 5000 }),
    row({ kind: 'deal_closed', amount: 250000 }),
  ]);
  assert.equal(s.counts.meetingsBooked, 2);
  assert.equal(s.counts.paymentsReceived, 1);
  assert.equal(s.counts.dealsClosed, 1);
});

// ── Currencies are never added together ─────────────────────────────────────

test('two currencies produce two rows and are NEVER summed', () => {
  // The whole point. A single "total value" across currencies looks precise
  // and means nothing.
  const s = summariseMoney([
    row({ amount: 400000, currency: 'INR' }),
    row({ amount: 5000, currency: 'USD' }),
  ]);
  assert.equal(s.byCurrency.length, 2);
  const inr = s.byCurrency.find((c) => c.currency === 'INR');
  const usd = s.byCurrency.find((c) => c.currency === 'USD');
  assert.equal(inr?.total, 400000);
  assert.equal(usd?.total, 5000);
  // Nothing anywhere equals 405000.
  assert.ok(!s.byCurrency.some((c) => c.total === 405000));
});

test('currencies sort by value, so the biggest is read first', () => {
  const s = summariseMoney([
    row({ amount: 100, currency: 'USD' }),
    row({ amount: 900000, currency: 'INR' }),
    row({ amount: 500, currency: 'AED' }),
  ]);
  assert.deepEqual(s.byCurrency.map((c) => c.currency), ['INR', 'AED', 'USD']);
});

test('the same currency written differently is ONE currency', () => {
  // Otherwise a business's own revenue splits across near-duplicate lines
  // that each look too small.
  const s = summariseMoney([
    row({ amount: 100, currency: 'inr' }),
    row({ amount: 200, currency: 'INR ' }),
    row({ amount: 300, currency: 'Inr' }),
  ]);
  assert.equal(s.byCurrency.length, 1);
  assert.equal(s.byCurrency[0].currency, 'INR');
  assert.equal(s.byCurrency[0].total, 600);
});

// ── Missing and zero amounts ────────────────────────────────────────────────

test('an outcome with no amount is counted but adds no money', () => {
  // A booked meeting usually carries no figure. It is real, and it is not
  // revenue.
  const s = summariseMoney([
    row({ kind: 'meeting_booked', amount: null, currency: null }),
    row({ kind: 'payment_received', amount: 5000 }),
  ]);
  assert.equal(s.counts.meetingsBooked, 1);
  assert.equal(s.counts.withoutAmount, 1);
  assert.equal(s.counts.withAmount, 1);
  assert.equal(s.byCurrency[0].total, 5000);
});

test('an amount with NO currency is not guessed at', () => {
  // "420000" of what? Guessing the currency of somebody's revenue is not a
  // defensible default.
  const s = summariseMoney([row({ amount: 420000, currency: null })]);
  assert.deepEqual(s.byCurrency, []);
  assert.equal(s.counts.withoutAmount, 1);
});

test('a genuine zero is money, and is not the same as missing', () => {
  const s = summariseMoney([
    row({ amount: 0, currency: 'INR' }),
    row({ amount: null, currency: null }),
  ]);
  assert.equal(s.counts.withAmount, 1);
  assert.equal(s.counts.withoutAmount, 1);
  assert.equal(s.byCurrency.length, 1);
  assert.equal(s.byCurrency[0].total, 0);
});

test('NaN is treated as missing, not as a number', () => {
  const s = summariseMoney([row({ amount: Number.NaN })]);
  assert.equal(s.counts.withoutAmount, 1);
  assert.deepEqual(s.byCurrency, []);
});

// ── Empty and edge ──────────────────────────────────────────────────────────

test('no outcomes gives zeros, never NaN', () => {
  const s = summariseMoney([]);
  assert.equal(s.counts.meetingsBooked, 0);
  assert.equal(s.counts.withAmount, 0);
  assert.deepEqual(s.byCurrency, []);
});

test('a refund does not silently vanish', () => {
  // Negative value is real. It reduces the total, and hiding it would make
  // every figure here optimistic by construction.
  const s = summariseMoney([
    row({ amount: 10000 }),
    row({ amount: -2500, kind: 'payment_received' }),
  ]);
  assert.equal(s.byCurrency[0].total, 7500);
});

test('fractional amounts do not drift across many rows', () => {
  const s = summariseMoney(Array.from({ length: 300 }, () => row({ amount: 0.1 })));
  assert.equal(s.byCurrency[0].total, 30);
});

// ── The autonomous share ────────────────────────────────────────────────────

test('the autonomous share is a percentage of that currency alone', () => {
  const s = summariseMoney([
    row({ amount: 750 }),
    row({ amount: 250, humanInvolved: true }),
  ]);
  assert.equal(autonomousValuePct(s.byCurrency[0]), 75);
});

test('no money means NULL, not 0%', () => {
  // "0% of value was handled autonomously" and "no money was recorded" are
  // opposite statements about a business.
  const s = summariseMoney([row({ amount: 0, currency: 'INR' })]);
  assert.equal(autonomousValuePct(s.byCurrency[0]), null);
});

test('all value on human-touched conversations reads 0%, honestly', () => {
  const s = summariseMoney([row({ amount: 5000, humanInvolved: true })]);
  assert.equal(autonomousValuePct(s.byCurrency[0]), 0);
});
