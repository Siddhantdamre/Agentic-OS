import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRegistry } from './registry.js';
import { assertSafeChange, type Policy } from './guard.js';
import { evaluateCandidate, type ScoreSet } from './gate.js';
import { advance, needsHuman, shouldRollback, CANARY_SHARE } from './rollout.js';
import { clusterFailures, proposalSummary, type FailureEvent } from './propose.js';
import type { CaseResult, Topic } from '../replay/grade.js';

const base: Policy = {
  text: 'Always get approval before sending.\nNever promise refunds.\nEscalate complaints to the owner.\nBe polite.',
  toolAllowlist: ['gmail', 'sheets'], autonomyStage: 2, approvalRequired: ['send_email'],
};

test('registry: versions, diff, rollback', () => {
  const r = new InMemoryRegistry();
  const v1 = r.create({ key: 'p', text: 'a\nb' });
  r.setStatus(v1.id, 'active', 'admin');
  const v2 = r.create({ key: 'p', text: 'a\nc', parent: v1.id });
  r.setStatus(v2.id, 'active', 'admin');
  assert.equal(r.active('p')!.id, v2.id);
  assert.equal(r.get(v1.id)!.status, 'rolled_back');
  const d = r.diff(v1.id, v2.id);
  assert.deepEqual([d.added, d.removed], [['c'], ['b']]);
  assert.equal(r.rollback(v2.id).id, v1.id);
  assert.equal(r.active('p')!.id, v1.id);
  assert.throws(() => r.rollback(v1.id));
  assert.throws(() => r.create({ key: 'q', text: 'x', parent: v1.id }));
});

test('guard: allows a stricter change', () => {
  const g = assertSafeChange(base, { ...base, text: base.text + '\nQuote only listed prices.', toolAllowlist: ['gmail'], autonomyStage: 1 });
  assert.equal(g.safe, true);
});
test('attack: sneaks a new tool into the allowlist', () => {
  const g = assertSafeChange(base, { ...base, toolAllowlist: ['gmail', 'sheets', 'Stripe_Refund'] });
  assert.equal(g.safe, false);
  assert.match(g.reasons[0], /stripe_refund/);
});
test('attack: deletes the approval clause', () => {
  const g = assertSafeChange(base, { ...base, text: 'Never promise refunds.\nEscalate complaints to the owner.' });
  assert.equal(g.safe, false);
  assert.ok(g.reasons.some((r) => /ask the owner before sending/.test(r)));
});
test('attack: removes refund and complaint rules, raises autonomy, drops approval requirement', () => {
  const g = assertSafeChange(base, { text: 'Approval before sending.', toolAllowlist: [], autonomyStage: 3, approvalRequired: [] });
  assert.equal(g.reasons.length, 4);
});
test('guard: NaN autonomy is refused', () => {
  assert.equal(assertSafeChange(base, { ...base, autonomyStage: NaN }).safe, false);
});

const topics: Topic[] = ['price', 'payment'];
function set(heldOut: boolean, sim: Record<string, number>, extra: Partial<CaseResult> = {}, nEach = 6): ScoreSet {
  const results: CaseResult[] = [];
  for (const t of topics) for (let i = 0; i < nEach; i++) results.push({ id: `${t}${i}`, topic: t, verdict: 'same', findings: [], similarity: sim[t], ...(i === 0 && extra.findings ? extra : {}) });
  return { heldOut, results };
}
test('gate: promotes a clear held-out win', () => {
  assert.equal(evaluateCandidate({ currentScores: set(true, { price: 0.5, payment: 0.5 }), candidateScores: set(true, { price: 0.7, payment: 0.6 }), topics }).decision, 'promote');
});
test('attack: wins only on the author\'s own data', () => {
  const r = evaluateCandidate({ currentScores: set(true, { price: 0.5, payment: 0.5 }), candidateScores: set(false, { price: 0.9, payment: 0.9 }), topics });
  assert.equal(r.decision, 'reject');
  assert.match(r.why[0], /held out/);
});
test('attack: wins overall but loses on payments', () => {
  const r = evaluateCandidate({ currentScores: set(true, { price: 0.5, payment: 0.6 }), candidateScores: set(true, { price: 0.95, payment: 0.5 }), topics });
  assert.equal(r.decision, 'reject');
  assert.ok(r.why.some((w) => /payment/.test(w)));
});
test('gate: too few cases or too few per topic needs more data', () => {
  assert.equal(evaluateCandidate({ currentScores: set(true, { price: 0.5, payment: 0.5 }, {}, 4), candidateScores: set(true, { price: 0.9, payment: 0.9 }, {}, 4), topics }).decision, 'need_more_data');
  const skew = (s: number) => { const x = set(true, { price: s, payment: s }, {}, 6); x.results = x.results.filter((r) => r.topic === 'price' || r.id === 'payment0'); return x; };
  assert.equal(evaluateCandidate({ currentScores: skew(0.5), candidateScores: skew(0.9), topics }).decision, 'need_more_data');
});
test('gate: a new invented number rejects even with big gains', () => {
  const cand = set(true, { price: 0.9, payment: 0.9 }, { findings: [{ code: 'invented_number', detail: 'x' }] });
  assert.equal(evaluateCandidate({ currentScores: set(true, { price: 0.5, payment: 0.5 }), candidateScores: cand, topics }).decision, 'reject');
});
test('gate: small gain rejected, mismatched cases rejected', () => {
  assert.equal(evaluateCandidate({ currentScores: set(true, { price: 0.5, payment: 0.5 }), candidateScores: set(true, { price: 0.51, payment: 0.51 }), topics }).decision, 'reject');
  const c = set(true, { price: 0.9, payment: 0.9 }); c.results[0].id = 'other';
  assert.equal(evaluateCandidate({ currentScores: set(true, { price: 0.5, payment: 0.5 }), candidateScores: c, topics }).decision, 'reject');
});

test('rollout: stages go in order and need a person', () => {
  assert.equal(CANARY_SHARE, 0.1);
  assert.equal(advance({ from: 'draft', to: 'canary', gatePassed: true, approvedBy: 'a' }).ok, false);
  assert.equal(advance({ from: 'draft', to: 'shadow', gatePassed: false }).ok, false);
  assert.equal(advance({ from: 'shadow', to: 'canary', gatePassed: true }).ok, false);
  assert.equal(advance({ from: 'shadow', to: 'canary', gatePassed: true, approvedBy: 'a' }).ok, true);
  assert.equal(advance({ from: 'active', to: 'draft', gatePassed: true, approvedBy: 'a' }).ok, false);
});
test('rollout: needsHuman never auto-applies', () => {
  assert.deepEqual(needsHuman({ kind: 'instruction' }), { required: true, approver: 'admin', autoApplyAllowed: false });
  assert.equal(needsHuman({ kind: 'knowledge' }).approver, 'owner');
});
test('rollout: rollback triggers and sample-size rule', () => {
  const b = { decided: 40, approved: 32, failedToRun: 0, complaints: 1 };
  assert.equal(shouldRollback({ baseline: b, current: { decided: 9, approved: 1, failedToRun: 5, complaints: 5 } }).rollback, false);
  assert.equal(shouldRollback({ baseline: b, current: { decided: 20, approved: 10, failedToRun: 0, complaints: 1 } }).rollback, true);
  assert.equal(shouldRollback({ baseline: b, current: { decided: 20, approved: 16, failedToRun: 4, complaints: 1 } }).rollback, true);
  assert.equal(shouldRollback({ baseline: b, current: { decided: 20, approved: 16, failedToRun: 0, complaints: 4 } }).rollback, true);
  assert.equal(shouldRollback({ baseline: b, current: { decided: 20, approved: 16, failedToRun: 0, complaints: 1 } }).rollback, false);
});

test('propose: picks the single highest-impact cluster with enough evidence', () => {
  const ev: FailureEvent[] = [];
  for (let i = 0; i < 8; i++) ev.push({ id: `e${i}`, kind: 'edit', topic: 'price' });
  for (let i = 0; i < 5; i++) ev.push({ id: `p${i}`, kind: 'replay_miss', topic: 'payment' });
  for (let i = 0; i < 4; i++) ev.push({ id: `c${i}`, kind: 'rejection', topic: 'complaint' });
  ev.push({ id: 'p0', kind: 'edit', topic: 'payment' });
  const c = clusterFailures(ev)!;
  assert.equal(c.topic, 'payment');
  assert.equal(c.count, 5);
  assert.equal(clusterFailures(ev.filter((e) => e.topic === 'complaint')), null);
  const note = proposalSummary({ cluster: c, change: 'Quote only prices from the price list.', kind: 'instruction' });
  for (const s of ['What I noticed', 'What I want to change', 'Why', "How we'll test it", 'admin']) assert.ok(note.includes(s), s);
});
