/**
 * Reading whether the work landed.
 *
 * The failures that matter are all in one direction: reading something as
 * satisfaction when it was not. That number gets quoted to a customer as
 * "your AI resolved 91% of conversations", and every false positive in here
 * makes that sentence less true.
 *
 * So the tests are weighted accordingly — most of them assert that something
 * did NOT read as positive.
 *
 * Run: node --test dist/satisfaction/signal.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { classifyCustomerReply, isRepeatedQuestion } from './signal';

const p = (s: string) => classifyCustomerReply(s).polarity;

// ── The rule that matters most ──────────────────────────────────────────────

test('AMBIGUITY IS NEVER POSITIVE', () => {
  // Every one of these is a real thing a customer types, and not one of them
  // says the answer was any good. Guessing kindly here is exactly how a
  // resolution rate comes to mean nothing.
  for (const s of [
    'ok', 'okay', 'haan', 'hmm', 'k', 'acha', 'right', 'i see', 'noted',
    'let me check', 'i will get back', 'one minute', 'hold on',
    'what about the other one', 'and the price for 3bhk?',
  ]) {
    assert.notEqual(p(s), 'positive', `"${s}" must not read as satisfaction`);
  }
});

test('silence is not an input at all', () => {
  for (const s of ['', '   ', '\n']) assert.equal(p(s), 'neutral');
});

test('emoji alone is not satisfaction', () => {
  assert.notEqual(p('👍'), 'positive');
});

// ── Clear positives ─────────────────────────────────────────────────────────

test('gratitude, in the registers this market uses', () => {
  for (const s of [
    'thanks', 'thank you so much', 'thanku', 'perfect thanks',
    'dhanyavaad', 'shukriya', 'theek hai', 'thik h', 'badhiya',
    'got it', 'that helps', 'ok thanks',
  ]) {
    assert.equal(p(s), 'positive', `"${s}" should read as satisfaction`);
  }
});

test('COMMITMENT outranks courtesy — a decision is the strongest signal', () => {
  const v = classifyCustomerReply('please book it for saturday');
  assert.equal(v.polarity, 'positive');
  assert.equal(v.strength, 'strong', 'acting on it beats saying thanks');
  assert.equal(classifyCustomerReply('thanks').strength, 'moderate');
});

test('Hinglish commitment is read too', () => {
  assert.equal(p('haan book kar dijiye'), 'positive');
});

// ── Clear negatives ─────────────────────────────────────────────────────────

test('asking for a human is a failure, however politely phrased', () => {
  // "thanks but can I speak to someone" is a failure with good manners.
  // Reading the courtesy instead of the request turns this metric into a
  // measure of politeness.
  const v = classifyCustomerReply('thanks but can i speak to a real person');
  assert.equal(v.polarity, 'negative');
  assert.equal(v.reason, 'asked for a person');
});

test('being told it was wrong', () => {
  for (const s of [
    'thats not what i asked', 'this is wrong', 'galat hai',
    'i already told you that', 'you didn\'t answer my question',
    'not helpful', 'bekar hai', 'still waiting',
  ]) {
    assert.equal(p(s), 'negative', `"${s}" should read as dissatisfaction`);
  }
});

test('declining is negative, not neutral', () => {
  assert.equal(p('nahi chahiye'), 'negative');
  assert.equal(p('not interested'), 'negative');
});

test('a bare question mark after an answer is confusion', () => {
  assert.equal(p('?'), 'negative');
  assert.equal(p('kya matlab?'), 'negative');
});

test('a LONG question is a new question, not a complaint', () => {
  // The narrow rule matters: ordinary follow-up curiosity must not be filed as
  // dissatisfaction, or the negative rate becomes a measure of engagement.
  assert.equal(
    p('and what about the maintenance charges for the second tower, are those separate?'),
    'neutral');
});

// ── Repeated questions ──────────────────────────────────────────────────────

test('THE FREE NEGATIVE: nobody asks twice when the answer worked', () => {
  assert.ok(isRepeatedQuestion(
    'what are your site visit timings',
    'timings for site visit?'));
});

test('the same question across two registers is still the same question', () => {
  assert.ok(isRepeatedQuestion(
    'what is the brokerage percentage',
    'brokerage percentage kitna hai'));
});

test('a different question is not a repeat', () => {
  assert.equal(isRepeatedQuestion(
    'what are your timings',
    'do you have parking available'), false);
});

test('two very short messages never count as a repeat', () => {
  // Guarding against coincidental overlap: "ok sure" and "sure ok" share
  // everything and mean nothing.
  assert.equal(isRepeatedQuestion('ok sure', 'sure ok'), false);
});

test('a follow-up that reuses topic words is not automatically a repeat', () => {
  assert.equal(isRepeatedQuestion(
    'what are your site visit timings',
    'can i bring my parents along to the visit and is parking available there'), false);
});
