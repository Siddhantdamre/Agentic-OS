import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, hivePrior, streakRule, DEFAULT_POLICY, ACCELERATED_POLICY, CONSERVATIVE_POLICY, LocalEvidence } from './posterior';
import { receipt, receiptText } from './explain';
import type { Release } from './privacy';

const rel = (approvals: number, rejections: number): Release => ({ suppressed: false, approvals, rejections, atLeastK: 5, epsilon: 1, clip: 20 });
const local = (approvals: number, rejections = 0, lockedOut = false): LocalEvidence => ({ approvals, rejections, lockedOut });
const SAFE = rel(400, 8);      // a cohort that approves ~98%
const RISKY = rel(30, 70);     // a cohort that approves ~30%

test('cold start: at the local floor, without the hive five approvals are not enough; with a safe cohort they are', () => {
  const floor = DEFAULT_POLICY.minLocalApprovals;
  const alone = decide({ graduatable: true, local: local(floor), hive: { optedIn: true, release: null } });
  assert.equal(alone.verdict, 'hold');
  const helped = decide({ graduatable: true, local: local(floor), hive: { optedIn: true, release: SAFE } });
  assert.equal(helped.verdict, 'graduate');
  assert.equal(helped.reason, 'posterior_sufficient');
  assert.ok(helped.prior.used && helped.prior.weight === DEFAULT_POLICY.maxPriorWeight);
  // The preset that trades robustness for speed graduates sooner still, on the same evidence.
  assert.equal(decide({ graduatable: true, local: local(3), hive: { optedIn: true, release: SAFE }, policy: ACCELERATED_POLICY }).verdict, 'graduate');
  assert.equal(decide({ graduatable: true, local: local(3), hive: { optedIn: true, release: SAFE } }).verdict, 'hold');
});

test('the hive can never remove the local floor', () => {
  const d = decide({ graduatable: true, local: local(DEFAULT_POLICY.minLocalApprovals - 1), hive: { optedIn: true, release: rel(100000, 0) } });
  assert.equal(d.verdict, 'hold');
  assert.equal(d.reason, 'needs_local_evidence');
});

test('the hive can never graduate a class that may never graduate', () => {
  const d = decide({ graduatable: false, local: local(500), hive: { optedIn: true, release: SAFE } });
  assert.equal(d.verdict, 'hold');
  assert.equal(d.reason, 'not_graduatable');
});

test('after your own "no", the hive stops helping until you re-earn the class', () => {
  const locked = decide({ graduatable: true, local: local(3, 1, true), hive: { optedIn: true, release: SAFE } });
  assert.equal(locked.prior.used, false);
  assert.equal(locked.verdict, 'hold');
  const same = decide({ graduatable: true, local: local(3, 1, false), hive: { optedIn: true, release: SAFE } });
  assert.ok(same.prior.used, 'control: without the lockout the prior is used');
});

test('caution: a cohort that mostly rejects raises the bar to your own strong evidence, not a lock', () => {
  // Plenty of your own approvals still clear the stricter test...
  const proven = decide({ graduatable: true, local: local(40), hive: { optedIn: true, release: RISKY } });
  assert.equal(proven.cautious, true);
  assert.equal(proven.verdict, 'graduate', 'a workspace that has proven itself is not locked out by the cohort');
  assert.equal(proven.prior.used, false, 'under caution the cohort is not a prior');
  // ...a modest streak does not.
  const modest = decide({ graduatable: true, local: local(12), hive: { optedIn: true, release: RISKY } });
  assert.equal(modest.verdict, 'hold');
  assert.equal(modest.reason, 'hive_caution');
  // ...and the same streak with no cohort signal would have been enough to at least be judged on the ordinary rule.
  assert.equal(decide({ graduatable: true, local: local(12), hive: { optedIn: true, release: null } }).verdict, 'graduate');
});

test('caution reads the full counts, not the weight-capped prior', () => {
  const d = decide({ graduatable: true, local: local(60), hive: { optedIn: true, release: RISKY } });
  assert.ok(d.veto.triggered);
  assert.equal(d.prior.weight, 0);
});

test('caution never applies the stricter bar to anyone the cohort has not warned about', () => {
  const d = decide({ graduatable: true, local: local(4), hive: { optedIn: true, release: SAFE } });
  assert.equal(d.cautious, false);
});

test('a cohort with too little released evidence does not veto (that would be acting on noise)', () => {
  const d = decide({ graduatable: true, local: local(12), hive: { optedIn: true, release: rel(1, 3) } });
  assert.equal(d.veto.evaluated, false);
  assert.equal(d.veto.triggered, false);
  // ...but the same proportions with enough observations do.
  const enough = decide({ graduatable: true, local: local(12), hive: { optedIn: true, release: rel(20, 60) } });
  assert.equal(enough.veto.triggered, true);
});

test('reciprocity: a workspace that did not opt in gets neither the prior nor the veto', () => {
  const d = decide({ graduatable: true, local: local(3), hive: { optedIn: false, release: SAFE } });
  assert.equal(d.prior.used, false);
  assert.equal(d.veto.evaluated, false);
  assert.equal(d.verdict, 'hold');
});

test('a suppressed release (below k) is no prior and no veto', () => {
  const d = decide({ graduatable: true, local: local(3), hive: { optedIn: true, release: { suppressed: true, reason: 'below_k', k: 5 } } });
  assert.equal(d.prior.used, false);
  assert.equal(d.veto.evaluated, false);
});

test('the prior is capped in weight and split exactly', () => {
  for (const [a, r] of [[400, 8], [5, 5], [1, 0], [123456, 789], [0, 50]]) {
    const p = hivePrior(rel(a, r), 12);
    assert.equal(p.approvals + p.rejections, p.weight);
    assert.equal(p.weight, Math.min(a + r, 12));
    assert.ok(p.approvals >= 0 && p.rejections >= 0);
  }
  assert.deepEqual(hivePrior(null, 12), { approvals: 0, rejections: 0, weight: 0 });
  assert.deepEqual(hivePrior(rel(0, 0), 12), { approvals: 0, rejections: 0, weight: 0 });
});

test('more local evidence always helps and a local rejection always hurts (fixed prior)', () => {
  const ok = (a: number, r: number) => decide({ graduatable: true, local: local(a, r), hive: { optedIn: true, release: null } });
  const pBelow = (a: number, r: number) => { const d = ok(a, r); const [n, den] = d.pBelowTau.split('/').map(BigInt); return Number(n * 10n ** 12n / den) / 1e12; };
  for (let a = 3; a < 30; a++) assert.ok(pBelow(a + 1, 0) < pBelow(a, 0));
  for (let a = 5; a < 30; a += 5) assert.ok(pBelow(a, 1) > pBelow(a, 0));
});

test('decisions are exactly reproducible', () => {
  const input = { graduatable: true, local: local(7, 1), hive: { optedIn: true, release: rel(311, 19) } };
  assert.equal(JSON.stringify(decide(input)), JSON.stringify(decide(input)));
});

test('the presets order as documented: more speed means a lower local floor and a heavier prior', () => {
  assert.ok(ACCELERATED_POLICY.minLocalApprovals < DEFAULT_POLICY.minLocalApprovals);
  assert.ok(DEFAULT_POLICY.minLocalApprovals < CONSERVATIVE_POLICY.minLocalApprovals);
  assert.ok(ACCELERATED_POLICY.maxPriorWeight > DEFAULT_POLICY.maxPriorWeight);
});

test('the current streak rule is unchanged and available as the comparison arm', () => {
  assert.equal(streakRule(9), false);
  assert.equal(streakRule(10), true);
});

test('the receipt states the evidence, the source of each piece, and the rule', () => {
  const d = decide({ graduatable: true, local: local(6), hive: { optedIn: true, release: SAFE } });
  const r = receipt('send', d);
  const text = receiptText('send', d);
  assert.match(r.headline, /send: may stop asking/);
  assert.match(text, /Your team: 6 approved, 0 rejected/);
  assert.match(text, /Other workspaces that chose to share: counted as \d+ approved, \d+ rejected/);
  assert.match(text, new RegExp(`capped at ${DEFAULT_POLICY.maxPriorWeight} observations so your own history always outweighs it`));
  assert.match(text, /Chance your approval rate is below 90%: [\d.]+% \(needs to be at most 35%\)/);
  assert.ok(r.reproduce.posterior.alpha > 6 && Number.isInteger(r.reproduce.posterior.alpha));
});

test('a held decision says why, in words a business owner can act on', () => {
  const veto = receiptText('price', decide({ graduatable: true, local: local(12), hive: { optedIn: true, release: RISKY } }));
  assert.match(veto, /price: keeps asking/);
  assert.match(veto, /usually rejected/);
  assert.match(veto, /at least 20 of your own approvals/);
  const never = receiptText('pay', decide({ graduatable: false, local: local(500), hive: { optedIn: false, release: null } }));
  assert.match(never, /never allowed to run without a person/);
});
