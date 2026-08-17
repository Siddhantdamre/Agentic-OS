/**
 * Mechanism talk must not reach a customer.
 *
 * This gate is two-sided and both sides matter:
 *
 *   Too loose → the customer gets a tour of the internals ("query the database",
 *   "check other payment connectors"), which is what failed reliability run 4.
 *
 *   Too strict → legitimate commercial answers get gutted. "We accept Stripe"
 *   and "your refund goes back to the original payment method" are exactly what
 *   a customer asked for. Stripping every payment word to fix a leak would make
 *   the product useless at its main job.
 *
 * So every rule below is paired with proof that a normal answer survives.
 *
 * Run: node --test dist/mechanism-talk.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { stripMechanismTalk } from './reply-gate';

/** Verbatim from the reliability run that failed on `no_internal_terms`. */
const FAILING_REPLY =
  'The revenue metric for the last financial year (April 2025 – March 2026) shows ₹0 '
  + 'collected via Stripe. This metric only tracks Stripe payments logged in your channel '
  + 'data, so it may not capture all revenue sources. Would you like me to check other '
  + 'payment connectors (Razorpay, QuickBooks invoices) or query the database directly '
  + 'for a broader revenue picture?';

// ── The regression ──────────────────────────────────────────────────────────

test('the exact failing reply loses its mechanism, keeps its answer', () => {
  const out = stripMechanismTalk(FAILING_REPLY);

  assert.ok(out.removed.length > 0, 'nothing was removed');
  // The internals are gone.
  assert.ok(!/query the database/i.test(out.text), 'database talk survived');
  assert.ok(!/payment connectors/i.test(out.text), 'connector talk survived');
  assert.ok(!/channel data/i.test(out.text), 'channel data survived');
  // The answer is still there — this is an edit, not a deletion.
  assert.match(out.text, /₹0/, 'the actual figure was lost');
});

test('the surviving text is a usable reply, not a fragment', () => {
  const out = stripMechanismTalk(FAILING_REPLY);
  assert.ok(out.text.length >= 20, `too short to send: ${JSON.stringify(out.text)}`);
  assert.match(out.text.trim(), /[.!?]$/, 'ends mid-sentence');
});

test('the quality rule that caught this now passes on the cleaned text', () => {
  // Closes the loop: the harness assertion that failed must now be satisfied.
  const out = stripMechanismTalk(FAILING_REPLY);
  const INTERNAL_TERMS =
    /\b(?:database|table|column|schema|sql|query|api|endpoint|connector|webhook|tool call|system prompt)\b/i;
  assert.ok(!INTERNAL_TERMS.test(out.text), `still trips no_internal_terms: ${out.text}`);
});

// ── Legitimate answers must survive untouched ───────────────────────────────

test('ordinary business answers are never edited', () => {
  const good = [
    'We open at 10am on Saturdays and close at 4pm.',
    'Refunds are processed to the original payment method within 7 working days.',
    'Yes, a delivery charge of ₹1,200 applies for locations outside Bengaluru.',
    'An initial design consultation costs ₹2,500, credited against orders over ₹50,000.',
    'Custom wardrobes take 4 to 6 weeks from design sign-off.',
    'Yes, standard installation is charged at 8% of the order value.',
    'You can cancel free of charge within 48 hours; after that a 15% restocking fee applies.',
  ];
  for (const g of good) {
    const out = stripMechanismTalk(g);
    assert.deepEqual(out.removed, [], `wrongly edited: ${g}`);
    assert.equal(out.text, g);
  }
});

test('payment brand names survive when they are the answer', () => {
  // "Do you take Stripe?" is a real customer question with a real answer.
  // Removing brand names to fix a mechanism leak would break the product.
  const good = [
    'Yes, we accept payment by card through Stripe.',
    'You can pay by Razorpay, UPI or bank transfer.',
    'Your invoice was raised in QuickBooks and emailed to you.',
  ];
  for (const g of good) {
    const out = stripMechanismTalk(g);
    assert.deepEqual(out.removed, [], `wrongly edited a legitimate payment answer: ${g}`);
  }
});

test('a mixed reply keeps the answer and drops only the mechanism sentence', () => {
  const out = stripMechanismTalk(
    'Your refund of ₹2,500 was issued on Tuesday. I checked the database to confirm it.',
  );
  assert.match(out.text, /₹2,500/);
  assert.ok(!/database/i.test(out.text));
  assert.equal(out.removed.length, 1);
});

test('empty and whitespace input are handled', () => {
  assert.equal(stripMechanismTalk('').text, '');
  assert.equal(stripMechanismTalk('   ').text, '');
  assert.deepEqual(stripMechanismTalk('').removed, []);
});

test('a reply that is ONLY mechanism collapses to nothing usable', () => {
  // The caller substitutes a neutral acknowledgement in this case rather than
  // sending a fragment — asserted here so that contract is not broken silently.
  const out = stripMechanismTalk('Let me query the database for you.');
  assert.ok(out.removed.length > 0);
  assert.ok(out.text.length < 20, `expected an unusable remainder, got: ${out.text}`);
});
