/**
 * Placeholder stripping — the deterministic backstop.
 *
 * Observed twice, verbatim, in the multi-turn suite:
 *   "Since today is [current date — please confirm], the next Saturday is
 *    [date — please confirm] — well within the two-day advance notice."
 *
 * The date IS in the prompt now and is usually resolved correctly — turn 2 of
 * the same conversation said "Saturday, 22 August". Injecting it reduced the
 * rate without eliminating it, which is the fourth prompt rule this session to
 * need a control behind it.
 *
 * The risk of over-stripping is real: brackets appear in legitimate replies
 * too, and eating a useful sentence to remove a cosmetic flaw is a bad trade.
 *
 * Run: node --test dist/placeholder.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { stripPlaceholders } from './reply-gate';

/** Verbatim from the failing run. */
const OBSERVED =
  'We offer 45-minute slots, and Saturday mornings at 10 am, 11 am and 12 pm are '
  + 'the most popular — they need to be confirmed at least two days ahead. '
  + 'Since today is [current date — please confirm], the next Saturday is '
  + '[date — please confirm].';

test('the exact observed reply loses the placeholder sentence, keeps the answer', () => {
  const out = stripPlaceholders(OBSERVED);

  assert.ok(out.removed.length > 0, 'nothing removed');
  assert.ok(!/\[/.test(out.text), `bracket survived: ${out.text}`);
  // The information the customer asked for is still there.
  assert.match(out.text, /45-minute/);
  assert.match(out.text, /10 am/);
  assert.match(out.text, /two days ahead/);
});

test('every placeholder syntax is caught', () => {
  const drafts = [
    'Your order ships soon. Thanks [customer name], we appreciate it.',
    'Your booking is set. Confirmed for {{slot_time}} on Saturday.',
    'We will be in touch. Please write to <support_email> if urgent.',
    'Your refund is processing. It lands on [date] in your account.',
  ];
  for (const d of drafts) {
    const out = stripPlaceholders(d);
    assert.ok(out.removed.length > 0, `not caught: ${d}`);
    assert.ok(!/\[|\{\{|<[a-z_]{2,30}>/.test(out.text), `survived: ${out.text}`);
  }
});

test('replies with no placeholder are untouched', () => {
  const good = [
    'We open at 10am on Saturdays and close at 4pm.',
    'Custom orders take 4 to 6 weeks from design sign-off.',
    'An initial design consultation costs ₹2,500.',
    'Yes, a delivery charge of ₹1,200 applies outside Bengaluru.',
  ];
  for (const g of good) {
    const out = stripPlaceholders(g);
    assert.deepEqual(out.removed, []);
    assert.equal(out.text, g);
  }
});

test('a legitimate bracketed aside is not mistaken for a placeholder', () => {
  // Parentheses are the common form and must never be touched.
  const draft = 'We are open Monday to Friday (closed on public holidays) from 9am.';
  const out = stripPlaceholders(draft);
  assert.deepEqual(out.removed, []);
  assert.equal(out.text, draft);
});

test('empty and whitespace input are safe', () => {
  assert.equal(stripPlaceholders('').text, '');
  assert.equal(stripPlaceholders('   ').text, '');
  assert.deepEqual(stripPlaceholders('').removed, []);
});

test('a reply that is ONLY a placeholder collapses to nothing usable', () => {
  // The caller substitutes a neutral acknowledgement rather than send a stub.
  const out = stripPlaceholders('Your appointment is [date].');
  assert.ok(out.removed.length > 0);
  assert.ok(out.text.length < 20, `expected an unusable remainder: ${out.text}`);
});

// ── Over-stripping: what "any bracket is a placeholder" actually cost ───────
//
// The original pattern was /\[[^\]\n]{2,60}\]/, which matches every square
// bracket in the language. Each case below is a correct reply the gate was
// mangling in production, found by probing the gate with realistic drafts
// rather than with the one failure that motivated it.

test('a CITATION does not delete the sentence that earned it', () => {
  // The worst of the three. A grounded answer carries [M-n] markers, so the
  // gate deleted precisely the sentences that were well sourced:
  //   in : "We are open until 6pm on Saturday [M-17]. Please call ahead."
  //   out: "Please call ahead."
  // The customer asked for the opening hours and got "Please call ahead."
  const out = stripPlaceholders('We are open until 6pm on Saturday [M-17]. Please call ahead.');
  assert.deepEqual(out.removed, []);
  assert.equal(out.text, 'We are open until 6pm on Saturday. Please call ahead.');
});

test('a markdown link survives, and is not cut in half at the domain dot', () => {
  // Two bugs in one draft: the bracket looked like a slot, and the sentence
  // splitter treated the dot in "example.com" as a sentence end — so the
  // customer received the fragment "com/book). We open at 9am."
  const draft = 'You can book here [our booking page](https://example.com/book). We open at 9am.';
  const out = stripPlaceholders(draft);
  assert.deepEqual(out.removed, []);
  assert.equal(out.text, draft);
});

test('a bracketed aside keeps the priced sentence it sits in', () => {
  const draft = 'The deposit is 5,000 rupees [refundable]. We hold it for 7 days.';
  const out = stripPlaceholders(draft);
  assert.deepEqual(out.removed, []);
  assert.equal(out.text, draft);
});

test('real slots are still stripped — the gate did not just get switched off', () => {
  for (const [draft, mustKeep] of [
    ['Your appointment is on [current date] at 3pm. See you then.', 'See you then.'],
    ['We will email you at <email> once it ships. Delivery takes 3 days.', 'Delivery takes 3 days.'],
    ['Since today is [date - please confirm], Saturday works. We open at 9am.', 'We open at 9am.'],
  ] as const) {
    const out = stripPlaceholders(draft);
    assert.ok(out.removed.length > 0, `slot not stripped: ${draft}`);
    assert.equal(out.text, mustKeep);
  }
});

test('a whole reply that is one template collapses, as before', () => {
  const out = stripPlaceholders('Hi {{name}}, your order ships Tuesday.');
  assert.ok(out.removed.length > 0);
  assert.equal(out.text, '');
});
