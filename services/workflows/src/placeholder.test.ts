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
