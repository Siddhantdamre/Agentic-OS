import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planNextRound,
  followUpQuery,
  stopNotice,
  MAX_ROUNDS,
  type ResearchRound,
} from './deep-research.js';

const round = (r: Partial<ResearchRound> & { round: number }): ResearchRound => ({
  queries: [],
  urlsRead: [],
  newDomains: 2,
  openQuestions: [],
  ...r,
});

test('the first round searches the topic and nothing invented around it', () => {
  const plan = planNextRound('Thane ready reckoner rates', []);
  assert.deepEqual(plan.queries, ['Thane ready reckoner rates']);
  assert.equal(plan.done, false);
});

test('follow-ups come from open questions, not from permuting the topic', () => {
  const plan = planNextRound('Thane ready reckoner rates', [
    round({ round: 1, queries: ['Thane ready reckoner rates'], openQuestions: ['whether the freeze applies to commercial units'] }),
  ]);
  assert.equal(plan.done, false);
  assert.equal(plan.queries.length, 1);
  assert.match(plan.queries[0], /commercial units/);
  // The topic's distinguishing words are carried in so the query is searchable.
  assert.match(plan.queries[0], /Thane/);
  // And nothing resembling permutation.
  assert.ok(!/latest|2026 2026|best/i.test(plan.queries[0]));
});

test('no open questions plus enough publishers is answered', () => {
  const plan = planNextRound('x', [round({ round: 1, newDomains: 4, openQuestions: [] })]);
  assert.equal(plan.done, true);
  assert.equal(plan.stopReason, 'answered');
});

test('no open questions on a thin evidence base is exhausted, never answered', () => {
  // An empty open-questions list after seeing one publisher is an incurious
  // model, not a settled question. Calling it "answered" is the lie.
  const plan = planNextRound('x', [round({ round: 1, newDomains: 1, openQuestions: [] })]);
  assert.equal(plan.stopReason, 'exhausted');
});

test('a round that added no new publisher stops instead of re-reading one site', () => {
  const plan = planNextRound('x', [
    round({ round: 1, newDomains: 3, openQuestions: ['q1'] }),
    round({ round: 2, newDomains: 0, openQuestions: ['q2'] }),
  ]);
  assert.equal(plan.done, true);
  assert.equal(plan.stopReason, 'no-progress');
});

test('the round ceiling holds even when the caller asks for more', () => {
  const history = Array.from({ length: MAX_ROUNDS }, (_, i) =>
    round({ round: i + 1, openQuestions: ['still open'] })
  );
  const plan = planNextRound('x', history, { maxRounds: 99 });
  assert.equal(plan.done, true);
  assert.equal(plan.stopReason, 'budget');
});

test('a question already asked is not asked again', () => {
  const openQuestion = 'whether the freeze applies to commercial units';
  // Derived, not hardcoded: the dedupe key is the generated query, so writing
  // the expected string by hand tests the fixture rather than the rule.
  const alreadyIssued = followUpQuery('Thane rates', openQuestion);
  const plan = planNextRound('Thane rates', [
    round({ round: 1, queries: [alreadyIssued], openQuestions: [openQuestion] }),
  ]);
  // The only follow-up available is the query we already issued.
  assert.equal(plan.done, true);
  assert.equal(plan.stopReason, 'exhausted');
});

test('deduplication ignores case and surrounding whitespace', () => {
  const openQuestion = 'whether rates rose';
  const issued = followUpQuery('Thane', openQuestion);
  const plan = planNextRound('Thane', [
    round({ round: 1, queries: [`  ${issued.toUpperCase()}  `], openQuestions: [openQuestion] }),
  ]);
  assert.equal(plan.stopReason, 'exhausted');
});

test('at most three follow-ups per round', () => {
  const plan = planNextRound('topic words here', [
    round({ round: 1, openQuestions: ['aaaa one', 'bbbb two', 'cccc three', 'dddd four', 'eeee five'] }),
  ]);
  assert.equal(plan.queries.length, 3);
});

test('followUpQuery strips the interrogative lead-in', () => {
  assert.ok(!/^whether/i.test(followUpQuery('t', 'whether rates changed')));
  assert.ok(!/^what/i.test(followUpQuery('t', 'what the penalty is')));
});

test('followUpQuery does not repeat a topic word already in the question', () => {
  const q = followUpQuery('Thane stamp duty', 'whether Thane raised stamp duty');
  assert.equal((q.match(/Thane/gi) || []).length, 1);
});

test('a partial run says so at the top of the report', () => {
  // The stop reason is the most misreadable part of a research report: a
  // confident findings list that hit the round limit is a partial answer and
  // nothing in the findings says so.
  assert.match(stopNotice('budget', 4, 7), /^PARTIAL/);
  assert.match(stopNotice('no-progress', 2, 3), /^PARTIAL/);
  assert.ok(!/^PARTIAL/.test(stopNotice('answered', 2, 5)));
});

test('the notice always states how many independent sources it rests on', () => {
  for (const reason of ['answered', 'budget', 'no-progress', 'exhausted'] as const) {
    assert.match(stopNotice(reason, 2, 5), /5 independent sources/);
  }
  assert.match(stopNotice('answered', 1, 1), /1 independent source\b/);
});
