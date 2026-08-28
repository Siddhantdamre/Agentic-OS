/**
 * The Monday email.
 *
 * Content tests, because the wording IS the feature. This email is the only
 * thing in the product that goes looking for the customer, and it gets one
 * shot a week — an email that overstates, or that reports zero of everything,
 * trains the reader to delete it unopened, and takes the next one that
 * mattered with it.
 *
 * Run: node --test dist/digest/weekly.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { buildWeeklyDigest, type WeeklyDigestData } from './weekly';

const BASE: WeeklyDigestData = {
  orgName: 'Bright Leaf Interiors',
  resolvedAlone: 42,
  neededPerson: 8,
  previousPct: 74,
  gaps: [
    { id: 'g1', question: 'Do you deliver to Whitefield?', timesAsked: 11 },
    { id: 'g2', question: 'What is the warranty on the sofas?', timesAsked: 3 },
  ],
  corrections: 5,
  gapsAnswered: 2,
  promisesKept: 9,
  promisesDue: 10,
  causalComparisonAvailable: false,
  brainUrl: 'https://app.darex.ai/brain',
};

const build = (over: Partial<WeeklyDigestData> = {}) =>
  buildWeeklyDigest({ ...BASE, ...over });

// ── The headline ────────────────────────────────────────────────────────────

test('the subject leads with the number, because that decides whether it opens', () => {
  const d = build();
  assert.ok(d);
  // 42 of 50 finished = 84%.
  assert.match(d.subject, /84%/);
});

test('the rate is over FINISHED conversations, not everything', () => {
  const d = build();
  assert.ok(d);
  assert.match(d.text, /50 conversations that finished/);
  assert.match(d.text, /handled 42 start to finish/);
});

test('change is reported in POINTS, never as a percentage of a percentage', () => {
  const d = build();
  assert.ok(d);
  // 84 vs 74 is 10 points. Reporting it as "up 13%" is the same fact dressed
  // up, and a reader who works that out stops believing the rest.
  assert.match(d.text, /10 points better/);
  assert.doesNotMatch(d.text, /13%|13 percent/);
});

test('a drop is stated plainly, not hidden or spun', () => {
  const d = build({ resolvedAlone: 30, neededPerson: 20, previousPct: 80 });
  assert.ok(d);
  assert.match(d.text, /60%/);
  assert.match(d.text, /20 points lower/);
});

test('the first week says so instead of inventing a comparison', () => {
  const d = build({ previousPct: null });
  assert.ok(d);
  assert.match(d.text, /first week/i);
  assert.doesNotMatch(d.text, /points (better|lower)/);
});

test('the half that needed a person is never netted out of the headline', () => {
  const d = build();
  assert.ok(d);
  assert.match(d.text, /8 needed one of your team/);
});

// ── Gaps: the one thing to do ───────────────────────────────────────────────

test('every open question appears, with how often it was asked', () => {
  const d = build();
  assert.ok(d);
  assert.match(d.text, /Do you deliver to Whitefield\?/);
  assert.match(d.text, /asked 11 times/);
  assert.match(d.text, /What is the warranty on the sofas\?/);
});

test('a question asked once does not say "asked 1 times"', () => {
  const d = build({ gaps: [{ id: 'g', question: 'Do you gift wrap?', timesAsked: 1 }] });
  assert.ok(d);
  assert.match(d.text, /Do you gift wrap\?/);
  assert.doesNotMatch(d.text, /asked 1 time/);
});

test('the email carries the link to answer them', () => {
  const d = build();
  assert.ok(d);
  assert.match(d.text, /https:\/\/app\.darex\.ai\/brain/);
  assert.match(d.html, /<a href="https:\/\/app\.darex\.ai\/brain">/);
});

test('no open questions is good news, and is said as such', () => {
  const d = build({ gaps: [] });
  assert.ok(d);
  assert.match(d.text, /answered every question/i);
  assert.doesNotMatch(d.text, /could not answer/);
});

// ── Honesty ─────────────────────────────────────────────────────────────────

test('teaching and the trend are never claimed to cause each other', () => {
  const d = build();
  assert.ok(d);
  // Both facts are present...
  assert.match(d.text, /corrected it 5 times/);
  assert.match(d.text, /10 points better/);
  // ...and the email says plainly that it cannot connect them.
  assert.match(d.text, /cannot tell you\s+one caused the other/);
  assert.doesNotMatch(d.text, /because your team/i);
});

test('with a holdout the caveat is dropped, because then there IS a control', () => {
  const d = build({ causalComparisonAvailable: true });
  assert.ok(d);
  assert.doesNotMatch(d.text, /cannot tell you/);
});

test('no comparison week means no causal caveat, because no claim was implied', () => {
  const d = build({ previousPct: null });
  assert.ok(d);
  assert.doesNotMatch(d.text, /cannot tell you/);
});

test('promises are reported as kept out of due, not as a bare count', () => {
  const d = build();
  assert.ok(d);
  assert.match(d.text, /promised to come back to 10 customers and did so 9 times \(90%\)/);
});

// ── Silence ─────────────────────────────────────────────────────────────────

test('a week with nothing to report sends NOTHING', () => {
  // An email that reports zero of everything trains the reader to delete it
  // unopened, and the next one that mattered goes with it.
  const d = build({
    resolvedAlone: 0, neededPerson: 0, gaps: [],
    corrections: 0, gapsAnswered: 0, promisesDue: 0, promisesKept: 0,
  });
  assert.equal(d, null);
});

test('open questions alone are worth an email even with no finished conversations', () => {
  const d = build({
    resolvedAlone: 0, neededPerson: 0,
    corrections: 0, gapsAnswered: 0, promisesDue: 0, promisesKept: 0,
  });
  assert.ok(d);
  assert.match(d.subject, /could not answer/);
  // With nothing finished there is no rate, and none must be invented.
  assert.doesNotMatch(d.text, /\d+%/);
});

// ── Plain language ──────────────────────────────────────────────────────────

test('no developer or product jargon reaches the reader', () => {
  const d = build();
  assert.ok(d);
  for (const jargon of [
    'autonomous', 'resolution rate', 'knowledge gap', 'org_id', 'workflow',
    'LLM', 'agent turn', 'outcome ledger', 'holdout', 'p50',
  ]) {
    assert.doesNotMatch(d.text, new RegExp(jargon, 'i'), `jargon leaked: ${jargon}`);
  }
});

test('the customer name is escaped in the HTML', () => {
  const d = build({ orgName: 'Smith & Sons <Interiors>' });
  assert.ok(d);
  assert.match(d.html, /Smith &amp; Sons &lt;Interiors&gt;/);
  assert.doesNotMatch(d.html, /<Interiors>/);
});
