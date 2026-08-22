/**
 * Preamble stripping.
 *
 * Caught by the multi-turn suite: the agent opened a booking reply with
 * "I'd be happy to help you book a showroom viewing." before any of the
 * information the customer asked for. The prompt already says lead with the
 * answer — it complied in 21 of 22 replies, which is exactly the rate at which
 * a prompt rule stops being a control.
 *
 * Two ways to get this wrong:
 *   - too timid, and the throat-clearing ships
 *   - too aggressive, and a short warm reply gets stripped to nothing, or a
 *     sentence that merely STARTS with "I understand" loses its meaning
 *
 * Run: node --test dist/preamble.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { stripPreamble } from './reply-gate';

/** Verbatim from the multi-turn run that failed `answer_first`. */
const OBSERVED =
  "I'd be happy to help you book a showroom viewing. Our viewings are 45-minute "
  + 'slots, with Saturday mornings at 10am, 11am, and 12pm being the most popular '
  + '— these need to be confirmed at least two days ahead.';

test('the exact observed reply loses its preamble and keeps its answer', () => {
  const out = stripPreamble(OBSERVED);

  assert.equal(out.removed, true, 'preamble not removed');
  assert.ok(!/i'?d be happy/i.test(out.text), 'preamble survived');
  // Everything the customer actually asked for is still there.
  assert.match(out.text, /45-minute/);
  assert.match(out.text, /10am/);
  assert.match(out.text, /two days ahead/);
  // Reads as a proper sentence, not a fragment.
  assert.match(out.text, /^[A-Z]/, 'does not start with a capital');
});

test('the cleaned reply satisfies the rule that flagged it', () => {
  // Closes the loop with the quality harness assertion.
  const ANSWER_FIRST =
    /^\s*(?:sure|certainly|of course|absolutely|great question|thanks for asking|i'?d be happy|i am happy|i'?m happy|i understand|happy to help|let me)\b/i;
  const out = stripPreamble(OBSERVED);
  assert.ok(!ANSWER_FIRST.test(out.text), `still trips answer_first: ${out.text}`);
});

test('common openers are all removed', () => {
  const openers = [
    'Sure! Our Saturday hours are 10am to 4pm and we are closed on Sunday.',
    'Of course. Refunds are processed within 7 working days of the return arriving.',
    'Certainly, installation is charged at 8% of the order value for all items.',
    'Great question. Custom orders take 4 to 6 weeks from design sign-off entirely.',
    'I can help you with that. A consultation costs ₹2,500, credited against orders.',
    'Let me help you here. Delivery outside Bengaluru carries a ₹1,200 charge.',
  ];
  for (const o of openers) {
    const out = stripPreamble(o);
    assert.equal(out.removed, true, `not stripped: ${o}`);
    assert.ok(out.text.length > 20, `stripped too much: ${o}`);
  }
});

// ── Must NOT over-strip ─────────────────────────────────────────────────────

test('a reply that is only a pleasantry is left intact', () => {
  // Stripping this leaves an empty message. A warm non-answer beats silence.
  for (const s of ['I’d be happy to help!', 'Sure!', 'Of course.', 'Happy to help.']) {
    const out = stripPreamble(s);
    assert.equal(out.removed, false, `wrongly stripped to nothing: ${s}`);
    assert.equal(out.text, s.trim());
  }
});

test('answers that already lead with the answer are untouched', () => {
  const good = [
    'We open at 10am on Saturdays and close at 4pm.',
    'Yes, a delivery charge of ₹1,200 applies outside Bengaluru.',
    'Custom orders take 4 to 6 weeks from design sign-off.',
    'Refunds are processed to the original payment method within 7 working days.',
    "I can't share other people's personal details — they're private to them.",
  ];
  for (const g of good) {
    const out = stripPreamble(g);
    assert.equal(out.removed, false, `wrongly edited: ${g}`);
    assert.equal(out.text, g);
  }
});

test('"I understand" is only stripped when it is a throat-clear, not the point', () => {
  // Removing the opener here would be fine — real content follows.
  const clear = stripPreamble(
    'I understand this is frustrating. Your order was despatched on Tuesday and arrives Friday.',
  );
  assert.equal(clear.removed, true);
  assert.match(clear.text, /despatched/);

  // But an apology-only reply keeps its whole meaning.
  const short = stripPreamble('I understand.');
  assert.equal(short.removed, false);
});

test('empty and whitespace input are safe', () => {
  assert.equal(stripPreamble('').text, '');
  assert.equal(stripPreamble('   ').text, '');
  assert.equal(stripPreamble('').removed, false);
});
