import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswer } from './answer.js';
import { verifyAnswer } from './numbers.js';
import { computeAll, GOLD_QUESTIONS, CORRECT_ANSWERS, WRONG_ANSWERS } from './gold.js';

const computed = computeAll();
const subset = (ids: string[]) => computed.filter((c) => ids.includes(c.id));

test('fixture values are what the gold set claims (scoped to org-1)', () => {
  const v = Object.fromEntries(computed.map((c) => [c.id, c.value]));
  assert.equal(v.overdue_total, 1802500);
  assert.equal(v.overdue_count, 3);
  assert.equal(Math.round((v.overdue_share as number) * 100) / 100, 80.02);
  assert.equal(v.paid_in_range, 540000);
  assert.equal(v.inquiries_in_range, 12);
  assert.equal(v.inquiries_closed, 4);
  assert.equal(v.active_listings, 7);
});

test('40 gold questions answered with the known value or a refusal', () => {
  assert.equal(GOLD_QUESTIONS.length, 40);
  let pass = 0;
  for (const g of GOLD_QUESTIONS) {
    const a = buildAnswer(g.q, computed);
    assert.ok(a.text.includes(g.expect), `${g.q} -> ${a.text}`);
    assert.equal(a.confidence, g.confidence, g.q);
    if (g.id) assert.ok(verifyAnswer(a.text, computed).ok, `own answer fails verification: ${a.text}`);
    pass++;
  }
  console.log(`gold questions passed: ${pass}/40`);
});

test('verifier catches 20/20 wrong answers', () => {
  assert.equal(WRONG_ANSWERS.length, 20);
  const missed = WRONG_ANSWERS.filter((w) => verifyAnswer(w.text, subset(w.ids)).ok);
  console.log(`wrong answers caught: ${20 - missed.length}/20`);
  assert.deepEqual(missed.map((m) => m.text), []);
});

test('verifier flags 0/20 correct answers', () => {
  assert.equal(CORRECT_ANSWERS.length, 20);
  const flagged = CORRECT_ANSWERS.map((c) => ({ c, r: verifyAnswer(c.text, subset(c.ids)) })).filter((x) => !x.r.ok);
  console.log(`correct answers flagged: ${flagged.length}/20`);
  assert.deepEqual(flagged.map((f) => [f.c.text, f.r.unsupported.map((u) => u.raw)]), []);
});
