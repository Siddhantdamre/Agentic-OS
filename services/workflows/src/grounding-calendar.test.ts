/**
 * Grounding: calendar inference vs fabrication.
 *
 * The exact failure, from a recorded critic_blocked event:
 *   {"reason":"only 33% of factual claims are supported by retrieved evidence",
 *    "violations":["date:22 Aug","number:2026"]}
 *
 * The agent answered "Can we book a viewing for Saturday morning?" correctly
 * from the knowledge base, then helpfully resolved WHICH Saturday. No document
 * will ever contain next Saturday's date, so the gate demanded evidence that
 * cannot exist, blocked the reply, and the customer got silence.
 *
 * This exemption is narrow by design: it must never become a hole a fabricated
 * figure can slip through. Every loosening test below is paired with a proof
 * that invented money, percentages and quantities are still caught.
 *
 * Run: node --test dist/grounding-calendar.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { evaluateGrounding, extractClaims, verifyClaims } from './grounding';

/** The seeded document the agent actually retrieved. */
const VIEWING_EVIDENCE =
  'Booking a showroom viewing — Showroom viewings are booked in 45 minute slots. '
  + 'Saturday morning slots at 10am, 11am and 12pm are the most requested and should '
  + 'be confirmed at least two days ahead. Customers should bring room measurements '
  + 'if they have them.';

// ── The regression: correct multi-fact answer must pass ─────────────────────

test('the viewing_slot answer that was blocked now passes', () => {
  // Shape of the real reply, including the resolved calendar date.
  const draft =
    'Yes, we can book a 45 minute showroom viewing on Saturday 22 Aug 2026. '
    + 'Slots are available at 10am, 11am and 12pm, and we ask that you confirm '
    + 'at least two days ahead.';
  const result = evaluateGrounding(draft, VIEWING_EVIDENCE);
  assert.equal(result.allow, true, `still blocked: ${result.reason}`);
});

test('the two claims recorded in the real block are now supported', () => {
  const draft = 'We can see you on Saturday 22 Aug 2026 at 10am.';
  const report = verifyClaims(extractClaims(draft), VIEWING_EVIDENCE);
  const unsupported = report.unsupported.map((c) => `${c.kind}:${c.text}`);
  assert.ok(!unsupported.some((u) => /22 Aug/i.test(u)), `date still unsupported: ${unsupported}`);
  assert.ok(!unsupported.some((u) => /2026/.test(u)), `year still unsupported: ${unsupported}`);
});

test('every fact in the answer traces to the document', () => {
  const draft =
    'Viewings run in 45 minute slots at 10am, 11am and 12pm on Saturday. '
    + 'Please confirm two days ahead.';
  const result = evaluateGrounding(draft, VIEWING_EVIDENCE);
  assert.equal(result.allow, true, result.reason);
});

// ── The guard: fabrication must STILL be caught ─────────────────────────────

test('an invented price is still blocked', () => {
  const result = evaluateGrounding(
    'Yes, we can book you in on Saturday 22 Aug 2026. The viewing costs ₹4,500.',
    VIEWING_EVIDENCE,
  );
  assert.equal(result.allow, false, 'a fabricated price got through');
  assert.ok(result.offending.some((c) => /4,?500/.test(c.text)));
});

test('an invented percentage is still blocked', () => {
  const result = evaluateGrounding(
    'Book on Saturday and we will take 30% off the order.',
    VIEWING_EVIDENCE,
  );
  assert.equal(result.allow, false, 'a fabricated percentage got through');
});

test('a date the evidence never mentions is still blocked', () => {
  // No weekday anywhere in the evidence to license this — it is an assertion
  // about the business, not arithmetic on today.
  const result = evaluateGrounding(
    'Your order will be delivered on 4 March.',
    'Delivery times — In-stock items are delivered within 3 to 5 working days.',
  );
  assert.equal(result.allow, false, 'an unsupported delivery date got through');
});

test('a bare year is only exempt in a temporal context', () => {
  // "2026 units in stock" is a quantity wearing a year's clothes.
  const report = verifyClaims(extractClaims('We have 2026 units in stock.'), VIEWING_EVIDENCE);
  assert.ok(
    report.unsupported.some((c) => c.text.includes('2026')),
    'a bare quantity that looks like a year was wrongly exempted',
  );
});

test('an invented quantity is still blocked', () => {
  const result = evaluateGrounding(
    'We have 37 showrooms across Karnataka.',
    VIEWING_EVIDENCE,
  );
  assert.equal(result.allow, false, 'a fabricated quantity got through');
});
