import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentSpeedSafety, experimentMembership, experimentPoisoning, experimentUtility } from './sim';

/**
 * The simulation's conclusions, as assertions. The full report
 * (infra/scripts/simulate-hive-trust.js, docs/adr/023) quotes numbers from
 * 1,000 trials per cell; these use fewer so they run in seconds, with margins
 * wide enough that sampling error cannot flip them. Fixed seeds: a failure here
 * is a change in behaviour, not bad luck.
 *
 * They pin what the mechanism is CLAIMED to do — and, just as deliberately,
 * what it is not: there is no assertion that the hive speeds up a mixed cohort,
 * because it does not.
 */
const SEED = 20260930;

test('safe cohort: the hive graduates in fewer reviews at the same safety', () => {
  const safe = experimentSpeedSafety(SEED, 500).find((r) => r.cls === 'safe')!;
  assert.ok(safe.H.medianReviews! < safe.L.medianReviews!, `hive ${safe.H.medianReviews} vs local ${safe.L.medianReviews}`);
  assert.ok(safe.H.medianReviews! < safe.S.medianReviews!, 'and fewer than the streak rule');
  assert.ok(safe.H.unsafe <= safe.L.unsafe + 0.02, 'without giving up safety');
  assert.ok(safe.H.graduated > 0.95, 'nearly all safe workspaces graduate');
});

test('risky cohort: today\'s streak rule graduates a large share of unsafe workspaces; the hive almost none', () => {
  const risky = experimentSpeedSafety(SEED, 500).find((r) => r.cls === 'risky')!;
  assert.ok(risky.S.unsafe > 0.25, `streak rule unsafe ${risky.S.unsafe}`);
  assert.ok(risky.H.unsafe < 0.03, `hive unsafe ${risky.H.unsafe}`);
  assert.ok(risky.H.unsafe < risky.L.unsafe, 'and fewer than the posterior alone');
  assert.ok(risky.vetoRate > 0.9, 'the cohort urges caution');
});

test('mixed cohort: the hive is a safety calibration, not a speedup (stated, not hidden)', () => {
  const mixed = experimentSpeedSafety(SEED, 500).find((r) => r.cls === 'mixed')!;
  assert.ok(mixed.H.unsafe < mixed.S.unsafe / 2, 'much safer than the streak rule');
  assert.ok(mixed.H.harm <= mixed.S.harm, 'and less harm among those that graduate');
  // Deliberately NO assertion that it is faster: it is not.
});

test('the experiment is deterministic in its seed', () => {
  assert.deepEqual(JSON.stringify(experimentSpeedSafety(SEED, 60)), JSON.stringify(experimentSpeedSafety(SEED, 60)));
});

test('membership inference never beats the theoretical bound for one release', () => {
  for (const r of experimentMembership(SEED, 3000, [0.5, 1, 2, 4], 3)) {
    assert.ok(r.accuracy1 <= r.bound + 0.03, `eps ${r.epsilon}: observed ${r.accuracy1} vs bound ${r.bound}`);
    assert.ok(r.accuracy1 > 0.5, 'the attack is real (better than chance), so the bound is being tested, not vacuous');
  }
});

test('repeated independent releases leak more, which is why the budget is per epoch', () => {
  const r = experimentMembership(SEED, 2500, [1], 10)[0];
  assert.ok(r.accuracyT > r.accuracy1 + 0.1, `1 release ${r.accuracy1}, 10 releases ${r.accuracyT}`);
});

test('a reject-only coalition slows a safe class but can no longer freeze it', () => {
  const rows = experimentPoisoning(SEED, 300, [0, 20, 300]);
  const at20 = rows.find((r) => r.colluders === 20)!;
  assert.ok(at20.safeClassNotGraduated < 0.15, `left asking: ${at20.safeClassNotGraduated} (the outright-veto design froze 100%)`);
  assert.ok(at20.safeMedianH !== null && at20.safeMedianH <= 40, `median reviews ${at20.safeMedianH}`);
});

test('an approve-only coalition is bounded, and stays far below the rule it replaces', () => {
  const base = experimentSpeedSafety(SEED, 300).find((r) => r.cls === 'risky')!;
  const rows = experimentPoisoning(SEED, 300, [0, 1000]);
  const poisoned = rows.find((r) => r.colluders === 1000)!;
  assert.ok(poisoned.H_unsafe > rows[0].H_unsafe, 'the attack does something (or the bound is untested)');
  assert.ok(poisoned.H_unsafe < 0.25, `poisoned unsafe ${poisoned.H_unsafe}`);
  assert.ok(poisoned.H_unsafe < base.S.unsafe / 2, 'even fully poisoned, well under half of today\'s streak rule');
});

test('noise: decisions are stable once the hive is large enough, and noise errs conservative when it does not', () => {
  const rows = experimentUtility(SEED, 60, [30, 300], [2]);
  const small = rows.find((r) => r.n === 30)!;
  const large = rows.find((r) => r.n === 300)!;
  assert.ok(large.decisionAgreement >= 0.97, `n=300: ${large.decisionAgreement}`);
  assert.ok(small.unsafeFlips <= small.conservativeFlips + 0.02, 'when noise flips a decision it flips toward asking, not toward acting');
});
