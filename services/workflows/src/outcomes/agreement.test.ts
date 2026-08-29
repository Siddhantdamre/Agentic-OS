/**
 * Shadow mode arithmetic.
 *
 * This number will be shown to a business as the reason to let the agent act
 * unsupervised, so every case below is one where being wrong in the
 * FLATTERING direction would cause real harm — a business granting autonomy on
 * evidence that was never there.
 *
 * Run: node --test dist/outcomes/agreement.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  summariseAgreement,
  agreementSentence,
  judge,
  MIN_SAMPLE,
  type AgreementCase,
} from './agreement';

const reply = (proposed: string, sent: string): AgreementCase =>
  ({ source: 'reply', proposed, humanOutcome: sent });
const approval = (outcome: 'approved' | 'rejected', reason?: string): AgreementCase =>
  ({ source: 'approval', proposed: 'send a quote', humanOutcome: outcome, reason });

const many = (n: number, c: () => AgreementCase) => Array.from({ length: n }, c);

// ── What counts as agreement ────────────────────────────────────────────────

test('an operator sending the draft untouched is agreement', () => {
  assert.equal(judge(reply('We open at 9am.', 'We open at 9am.')), 'agreed');
});

test('tidying whitespace or punctuation is not disagreement', () => {
  // The operator fixed a double space. They did not disagree with the agent,
  // and counting it as a disagreement hides the real ones.
  assert.equal(judge(reply('We open  at 9am.', 'We open at 9am')), 'cosmetic');
  assert.equal(judge(reply('It costs 5,000.', 'It costs 5,000')), 'cosmetic');
});

test('a ONE WORD change of substance is a disagreement', () => {
  // The case that decides whether this metric is honest. A similarity
  // threshold would call this a 95% match; it is the most important
  // correction a business can make.
  assert.equal(judge(reply(
    'You can return items within 30 days.',
    'You can return items within 45 days.',
  )), 'disagreed');
});

test('an approval is agreement and a rejection is not', () => {
  assert.equal(judge(approval('approved')), 'agreed');
  assert.equal(judge(approval('rejected', 'price was wrong')), 'disagreed');
});

test('an empty draft or an empty send is never counted as agreement', () => {
  assert.equal(judge(reply('', 'anything')), 'disagreed');
  assert.equal(judge(reply('anything', '')), 'disagreed');
});

// ── The headline ────────────────────────────────────────────────────────────

test('the rate counts cosmetic edits as agreement, and says how many', () => {
  const cases = [
    ...many(7, () => reply('Same text.', 'Same text.')),
    ...many(2, () => reply('Same  text.', 'Same text')),
    reply('We open at 9am.', 'We open at 10am.'),
  ];
  const s = summariseAgreement(cases);
  assert.equal(s.decided, 10);
  assert.equal(s.agreed, 7);
  assert.equal(s.cosmetic, 2);
  assert.equal(s.disagreed, 1);
  assert.equal(s.agreementPct, 90);
});

test('below the minimum sample there is NO percentage', () => {
  // "3 of 4" is not 75% in any sense a business should act on, and a figure
  // that swings 25 points per data point invites the decision it cannot
  // support.
  const s = summariseAgreement(many(4, () => reply('x', 'x')));
  assert.equal(s.agreementPct, null);
  assert.equal(s.agreed, 4);
  assert.match(agreementSentence(s), /Too few to put a figure on/);
  assert.match(agreementSentence(s), new RegExp(String(MIN_SAMPLE)));
});

test('no decisions at all says so, rather than reporting 0%', () => {
  const s = summariseAgreement([]);
  assert.equal(s.decided, 0);
  assert.equal(s.agreementPct, null);
  assert.match(agreementSentence(s), /No decisions yet/);
});

test('total disagreement reads 0%, honestly', () => {
  const s = summariseAgreement(many(12, () => approval('rejected', 'no')));
  assert.equal(s.agreementPct, 0);
  assert.equal(s.disagreed, 12);
});

// ── The wording is the product ──────────────────────────────────────────────

test('the sentence claims AGREEMENT, never correctness', () => {
  // The human is ground truth for what THIS business would do, not for what
  // is right. An agent agreeing perfectly with a mistaken operator is
  // agreeing perfectly and performing badly.
  const s = summariseAgreement([
    ...many(11, () => reply('x', 'x')),
    reply('a', 'b'),
  ]);
  const sentence = agreementSentence(s);
  assert.match(sentence, /would have done the same thing/);
  assert.doesNotMatch(sentence, /correct|accurate|right|accuracy/i);
});

test('the sentence carries both numbers, not just the flattering one', () => {
  const s = summariseAgreement([
    ...many(9, () => reply('x', 'x')),
    ...many(3, () => reply('a', 'b')),
  ]);
  const sentence = agreementSentence(s);
  assert.match(sentence, /12 decisions/);   // the denominator
  assert.match(sentence, /9 times/);        // the numerator
  assert.match(sentence, /75%/);
});

// ── Disagreements are the useful half ───────────────────────────────────────

test('disagreements are returned so they can be read', () => {
  const s = summariseAgreement([
    reply('We open at 9am.', 'We open at 9am.'),
    reply('Returns are 30 days.', 'Returns are 45 days — we extended it.'),
    approval('rejected', 'wrong customer'),
  ]);
  assert.equal(s.disagreements.length, 2);
  assert.ok(s.disagreements.every((d) => d.verdict === 'disagreed'));
  assert.ok(s.disagreements.some((d) => d.reason === 'wrong customer'));
});

test('the newest disagreement is first', () => {
  const s = summariseAgreement([
    reply('old', 'OLD DIFFERENT'),
    reply('new', 'NEW DIFFERENT'),
  ]);
  assert.equal(s.disagreements[0].proposed, 'new');
});

test('agreement is broken out per source', () => {
  // Replies and consequential actions are different kinds of trust. An agent
  // that writes well but wants to send the wrong things is not the same as
  // one that writes badly and never oversteps.
  const s = summariseAgreement([
    ...many(3, () => reply('x', 'x')),
    reply('a', 'b'),
    ...many(2, () => approval('approved')),
    approval('rejected', 'no'),
  ]);
  assert.deepEqual(s.bySource.reply, { decided: 4, agreed: 3 });
  assert.deepEqual(s.bySource.approval, { decided: 3, agreed: 2 });
});
