/**
 * Dates the PLATFORM supplies are grounded — but only for date claims.
 *
 * From a real reliability run, `viewing_slot` at run 6 of 20:
 *   {"policy":"grounding","reason":"only 75% of factual claims are supported
 *    by retrieved evidence","violations":["date:22 Aug"]}
 *
 * The agent answered correctly and the gate blocked it. "22 Aug" appeared in no
 * tool result and no memory row — but the system had computed it and put it in
 * the prompt, so the agent was repeating a supplied fact, not inventing one.
 *
 * The first fix folded the supplied dates into the general evidence string.
 * That unblocked the correct reply and opened a real hole, caught by the
 * `invented percentage` test below: today is 23 August, so the date block reads
 * "Next Saturday is Saturday, 30 August 2026" — and those digits grounded an
 * invented "30% off the order". Widening evidence is exactly how a fabrication
 * guard springs a leak.
 *
 * So supplied dates now travel in their own channel, `GroundingPolicy.
 * dateContext`, and are consulted ONLY when the claim's kind is `date`. Money,
 * percentages and quantities never see them. The last test in this file pins
 * the hole itself: it proves the folded-in arrangement really did ground the
 * fabricated percentage, so nobody reintroduces it as a simplification.
 *
 * Run: node --test dist/supplied-dates.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { evaluateGrounding } from './grounding';
import { buildDateContext } from './atomic-agent-client';

/** Exactly what WorkItemWorkflow passes as `dateContext`. */
function suppliedDates(): string {
  const { today, lines } = buildDateContext();
  return [`Today is ${today}.`, ...lines].join(' | ');
}

/** Exactly how WorkItemWorkflow calls the gate: dates separate from evidence. */
function gate(draft: string, retrieved: string) {
  return evaluateGrounding(draft, retrieved, { dateContext: suppliedDates() });
}

const VIEWING_DOC =
  'Booking a showroom viewing — Showroom viewings are booked in 45 minute slots. '
  + 'Saturday morning slots at 10am, 11am and 12pm are the most requested and should '
  + 'be confirmed at least two days ahead.';

test('the supplied dates are non-empty and name the weekdays a customer asks about', () => {
  const { today, lines } = buildDateContext();
  assert.ok(today.length > 0, 'today is empty');
  assert.ok(lines.length >= 4, 'too few precomputed dates');
  const all = lines.join(' ');
  for (const day of ['Monday', 'Saturday']) {
    assert.ok(all.includes(day), `${day} missing from supplied dates`);
  }
});

test('a reply naming a supplied date is grounded', () => {
  // The shape that was blocked in the real run.
  const { lines } = buildDateContext();
  const nextSat = /Next Saturday is ([^.]+)\./.exec(lines.join('\n'));
  assert.ok(nextSat, 'could not read next Saturday from the supplied dates');

  const draft =
    `Yes — we can book a 45 minute viewing on ${nextSat[1]} at 10am, 11am or 12pm. `
    + 'Please confirm at least two days ahead.';
  const result = gate(draft, VIEWING_DOC);
  assert.equal(result.allow, true, `still blocked: ${result.reason}`);
});

test('every fact in a correct multi-fact answer traces to evidence', () => {
  const draft =
    'Viewings run in 45 minute slots at 10am, 11am and 12pm on Saturday, '
    + 'confirmed two days ahead.';
  const result = gate(draft, VIEWING_DOC);
  assert.equal(result.allow, true, result.reason);
});

// ── The guard: a separate date channel must not let fabrication through ─────

test('an invented price is still blocked', () => {
  const result = gate('Your viewing is booked and the deposit is ₹4,500.', VIEWING_DOC);
  assert.equal(result.allow, false, 'a fabricated price got through');
});

test('an invented percentage is still blocked', () => {
  const result = gate(
    'Book a viewing on Saturday and we will take 30% off the order.',
    VIEWING_DOC,
  );
  assert.equal(result.allow, false, 'a fabricated percentage got through');
});

test('an invented quantity is still blocked', () => {
  const result = gate('We have 37 showrooms across Karnataka.', VIEWING_DOC);
  assert.equal(result.allow, false, 'a fabricated quantity got through');
});

test('supplied dates do not ground an UNRELATED invented figure', () => {
  // The specific hole to avoid: the date block contains many numbers, and they
  // must not accidentally support a claim that has nothing to do with dates.
  const result = gate('Your order total is ₹87,400 including installation.', VIEWING_DOC);
  assert.equal(result.allow, false, 'a price was grounded by the date block');
});

test('REGRESSION: folding supplied dates into evidence really did ground a fabrication', () => {
  // Not a wish — a demonstration. This is the arrangement that shipped first,
  // and it lets "30% off" through whenever the date block happens to contain a
  // 30. Kept so the separation above is never simplified away as redundant.
  const draft = 'Book a viewing on Saturday and we will take 30% off the order.';
  const { lines } = buildDateContext();

  if (/\b30\b/.test(lines.join(' '))) {
    const folded = [VIEWING_DOC, suppliedDates()].join('\n');
    assert.equal(
      evaluateGrounding(draft, folded).allow,
      true,
      'the folded arrangement was expected to leak here — if it no longer does, '
        + 'the claim matcher changed and this test needs rewriting, not deleting',
    );
  }
  // Whatever today's date is, the shipped arrangement must block it.
  assert.equal(gate(draft, VIEWING_DOC).allow, false, 'the shipped gate leaked');
});
