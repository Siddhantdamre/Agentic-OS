/**
 * World model tests.
 *
 * Anomaly detection is judged on its false positives. An alert people learn to
 * ignore is worse than no alert, so most of these assert the system stays
 * SILENT when it should — especially early, when an org has little history.
 *
 * Run: node --test dist/world-model.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  computeBaseline,
  detectAnomaly,
  buildSnapshot,
  MIN_BASELINE_SAMPLES,
} from './world-model';

/** ~10 minute typical first-response time, with normal variation. */
const RESPONSE_TIMES = [9, 11, 10, 12, 8, 10, 11, 9, 13, 10, 11, 9];

test('TRUST: no baseline before the minimum sample size', () => {
  // The failure mode this prevents: a brand-new org gets alerted about
  // everything, stops trusting alerts, and the feature is dead on arrival.
  const b = computeBaseline('response_minutes', [10, 12, 9]);
  assert.strictEqual(b.sufficient, false);
  assert.match(b.note, new RegExp(`need ${MIN_BASELINE_SAMPLES}`));

  const v = detectAnomaly(600, b);
  assert.strictEqual(v.isAnomaly, false, 'must stay silent without enough history');
  assert.match(v.explanation, /need \d+/);
});

test('an obvious outlier is caught once there is history', () => {
  const b = computeBaseline('response_minutes', RESPONSE_TIMES);
  assert.strictEqual(b.sufficient, true);
  const v = detectAnomaly(240, b);
  assert.strictEqual(v.isAnomaly, true);
  assert.strictEqual(v.direction, 'above');
  assert.ok(['significant', 'extreme'].includes(v.severity));
});

test('QUALITY: normal variation is not flagged', () => {
  const b = computeBaseline('response_minutes', RESPONSE_TIMES);
  for (const v of [9, 10, 11, 12, 8]) {
    assert.strictEqual(detectAnomaly(v, b).isAnomaly, false, `false alarm on ${v}`);
  }
});

test('ROBUSTNESS: one huge outlier does not blind the metric', () => {
  // With mean/stddev, a single 5000 inflates the deviation so much that a
  // genuine 240 afterwards looks normal. Median/MAD resists that.
  const contaminated = [...RESPONSE_TIMES, 5000];
  const b = computeBaseline('response_minutes', contaminated);
  const v = detectAnomaly(240, b);
  assert.strictEqual(v.isAnomaly, true, 'outlier contamination must not mask later anomalies');
});

test('detects a drop as well as a spike', () => {
  const b = computeBaseline('daily_leads', [20, 22, 19, 21, 20, 23, 18, 21, 20, 22, 19, 21]);
  const v = detectAnomaly(2, b);
  assert.strictEqual(v.isAnomaly, true);
  assert.strictEqual(v.direction, 'below');
});

test('TRUST: zero spread reports "unmeasurable", not infinite confidence', () => {
  // Naive robust-z divides by MAD; MAD=0 yields Infinity and a claim of
  // absolute certainty from data that cannot support it.
  const b = computeBaseline('daily_bookings', Array(12).fill(5));
  assert.strictEqual(b.mad, 0);
  const v = detectAnomaly(6, b);
  assert.strictEqual(v.robustZ, null, 'must not report a z-score');
  assert.strictEqual(v.isAnomaly, false);
  assert.match(v.explanation, /cannot be measured/i);
});

test('a value matching a zero-spread baseline is simply normal', () => {
  const b = computeBaseline('daily_bookings', Array(12).fill(5));
  assert.match(detectAnomaly(5, b).explanation, /matches the usual/i);
});

test('SAFETY: bad values are discarded, not propagated as NaN', () => {
  const b = computeBaseline('m', [10, NaN, 11, Infinity, 9, 10, 12, 11, 10, 9, 11, 10]);
  assert.ok(Number.isFinite(b.median));
  assert.ok(Number.isFinite(b.mad));
  assert.strictEqual(b.samples, 10, 'non-finite values excluded from the count');
});

test('SAFETY: a non-numeric current value is rejected, not judged', () => {
  const b = computeBaseline('m', RESPONSE_TIMES);
  const v = detectAnomaly(Number.NaN, b);
  assert.strictEqual(v.isAnomaly, false);
  assert.match(v.explanation, /not a number/i);
});

test('SAFETY: an empty history never produces an anomaly', () => {
  const b = computeBaseline('m', []);
  assert.strictEqual(b.sufficient, false);
  assert.strictEqual(detectAnomaly(999999, b).isAnomaly, false);
});

test('explanations state the evidence, never bare assertion', () => {
  const b = computeBaseline('response_minutes', RESPONSE_TIMES);
  const v = detectAnomaly(240, b);
  assert.match(v.explanation, /usual/, 'must say what normal is');
  assert.match(v.explanation, /observations/, 'must say how much data it is based on');
});

test('snapshot ranks the most severe anomaly first', () => {
  const snap = buildSnapshot(
    {
      response_minutes: RESPONSE_TIMES,
      daily_leads: [20, 22, 19, 21, 20, 23, 18, 21, 20, 22, 19, 21],
    },
    { response_minutes: 45, daily_leads: 1 }
  );
  assert.ok(snap.anomalies.length >= 1);
  const rank = { extreme: 3, significant: 2, notable: 1, none: 0 } as const;
  for (let i = 1; i < snap.anomalies.length; i++) {
    assert.ok(
      rank[snap.anomalies[i - 1].severity] >= rank[snap.anomalies[i].severity],
      'anomalies must be ordered worst-first'
    );
  }
});

test('TRUST: metrics lacking history are surfaced as gaps, not hidden', () => {
  // Showing what cannot yet be judged is itself useful, and prevents the
  // impression that silence means "all fine".
  const snap = buildSnapshot(
    { established: RESPONSE_TIMES, brand_new: [5, 6] },
    { established: 10, brand_new: 900 }
  );
  assert.ok(snap.insufficientMetrics.includes('brand_new'));
  assert.strictEqual(snap.anomalies.some((a) => a.metric === 'brand_new'), false);
});

test('a metric with no current reading is skipped safely', () => {
  const snap = buildSnapshot({ response_minutes: RESPONSE_TIMES }, {});
  assert.strictEqual(snap.anomalies.length, 0);
  assert.ok(snap.baselines.response_minutes.sufficient);
});
