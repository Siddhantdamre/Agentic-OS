/**
 * The two questions that drove this module are the first two tests, verbatim
 * from the demo workspace's real knowledge-gap rows. If either ever flips
 * classification, the product either shrugs at public knowledge or quotes a
 * competitor's flat as its own.
 *
 * Run: node --test dist/answerable.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  classifyAnswerability,
  shouldAttemptLookup,
  searchedButNotFound,
} from './answerable';

// ── The two real gaps ──────────────────────────────────────────────────────

test('inventory question stays internal — the expensive direction', () => {
  const v = classifyAnswerability('Do you have anything in Chembur under 90 lakh?');
  assert.strictEqual(v.kind, 'internal');
});

test('public duty question is external — the embarrassing direction', () => {
  const v = classifyAnswerability('What is the stamp duty on a 1.2cr flat in Thane?');
  assert.strictEqual(v.kind, 'external');
  assert.match(v.reason, /tax or duty/);
});

// ── Internal wins when a question carries both ─────────────────────────────

test('a public rule applied to our inventory is internal', () => {
  // Answering needs a fact only this business holds; no public source has it.
  const v = classifyAnswerability('What is the stamp duty on your 2BHK in Chembur?');
  assert.strictEqual(v.kind, 'internal');
});

// ── Fails towards the human ────────────────────────────────────────────────

test('an unrecognised question is internal, not external', () => {
  const v = classifyAnswerability('Chembur 90 lakh?');
  assert.strictEqual(v.kind, 'internal');
  assert.match(v.reason, /no public-fact marker/);
});

test('an empty question is internal', () => {
  assert.strictEqual(classifyAnswerability('').kind, 'internal');
  assert.strictEqual(classifyAnswerability('   ').kind, 'internal');
});

// ── Internal markers ───────────────────────────────────────────────────────

test('questions about this business are internal', () => {
  const internal = [
    'Do you have a 3BHK in Powai?',
    'What is your brokerage rate?',
    'Can we visit on Sunday?',
    'What is the status of my booking?',
    'How much do you charge for rental agreements?',
    'Is that flat still available?',
    'When can you show me the property?',
  ];
  for (const q of internal) {
    assert.strictEqual(classifyAnswerability(q).kind, 'internal', q);
  }
});

// ── External markers ───────────────────────────────────────────────────────

test('questions about the world are external', () => {
  const external = [
    'What is the stamp duty in Maharashtra?',
    'What is RERA registration?',
    'What is the difference between carpet area and built-up area?',
    'What are the current home loan interest rates?',
    'What is the market rate in Thane?',
    'What is the GST on under-construction property?',
  ];
  for (const q of external) {
    assert.strictEqual(classifyAnswerability(q).kind, 'external', q);
  }
});

// ── The lookup decision ────────────────────────────────────────────────────

test('no lookup when the agent actually answered', () => {
  const d = shouldAttemptLookup({
    isDenial: false,
    question: 'What is the stamp duty in Thane?',
    retrievalAvailable: true,
  });
  assert.strictEqual(d.attempt, false);
  assert.match(d.reason, /the agent answered/);
});

test('no lookup when no retrieval tool is reachable', () => {
  // Otherwise this is a slower denial that also costs a model call.
  const d = shouldAttemptLookup({
    isDenial: true,
    question: 'What is the stamp duty in Thane?',
    retrievalAvailable: false,
  });
  assert.strictEqual(d.attempt, false);
  assert.match(d.reason, /no retrieval tool/);
});

test('no lookup for an internal question even when retrieval works', () => {
  // The whole point: never search the web for our own inventory.
  const d = shouldAttemptLookup({
    isDenial: true,
    question: 'Do you have anything in Chembur under 90 lakh?',
    retrievalAvailable: true,
  });
  assert.strictEqual(d.attempt, false);
  assert.match(d.reason, /a person must answer it/);
});

test('lookup proceeds for a public question with retrieval available', () => {
  const d = shouldAttemptLookup({
    isDenial: true,
    question: 'What is the stamp duty on a 1.2cr flat in Thane?',
    retrievalAvailable: true,
  });
  assert.strictEqual(d.attempt, true);
  assert.match(d.reason, /public question/);
});

// ── The sentence when a search came back empty ─────────────────────────────

test('a searched denial names where it looked and commits a person', () => {
  const s = searchedButNotFound('anything', ['maharera.gov.in', 'incometax.gov.in']);
  assert.match(s, /maharera\.gov\.in/);
  assert.match(s, /colleague/);
  // Never the shrug it replaces.
  assert.ok(!/do not have that information/i.test(s));
});

test('it still names a source when the list is empty', () => {
  const s = searchedButNotFound('anything', []);
  assert.match(s, /sources available to me/);
});
