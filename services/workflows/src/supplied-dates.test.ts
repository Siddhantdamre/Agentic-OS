/**
 * Dates the PLATFORM supplies are evidence.
 *
 * From a real reliability run, `viewing_slot` at run 6 of 20:
 *   {"policy":"grounding","reason":"only 75% of factual claims are supported
 *    by retrieved evidence","violations":["date:22 Aug"]}
 *
 * The agent answered correctly and the gate blocked it. "22 Aug" appeared in no
 * tool result and no memory row — but the system had computed it and put it in
 * the prompt, so the agent was repeating a supplied fact, not inventing one.
 *
 * An earlier attempt exempted calendar inference only when the weekday sat next
 * to the date in the claim's immediate context window. That held for one
 * phrasing and failed for others, which is why this now works from the evidence
 * side instead: anything the platform tells the agent is as grounded as
 * anything the agent looks up.
 *
 * The risk is obvious — widening evidence is how a fabrication guard springs a
 * leak — so every test below is paired with proof that invented figures still
 * fail.
 *
 * Run: node --test dist/supplied-dates.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { evaluateGrounding } from './grounding';
import { buildDateContext } from './atomic-agent-client';

/** Exactly what WorkItemWorkflow now assembles: retrieved text + supplied dates. */
function evidenceWithDates(retrieved: string): string {
  const { today, lines } = buildDateContext();
  return [retrieved, `Today is ${today}.`, ...lines].join('\n');
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
  const result = evaluateGrounding(draft, evidenceWithDates(VIEWING_DOC));
  assert.equal(result.allow, true, `still blocked: ${result.reason}`);
});

test('every fact in a correct multi-fact answer traces to evidence', () => {
  const draft =
    'Viewings run in 45 minute slots at 10am, 11am and 12pm on Saturday, '
    + 'confirmed two days ahead.';
  const result = evaluateGrounding(draft, evidenceWithDates(VIEWING_DOC));
  assert.equal(result.allow, true, result.reason);
});

// ── The guard: widening evidence must not let fabrication through ───────────

test('an invented price is still blocked', () => {
  const result = evaluateGrounding(
    'Your viewing is booked and the deposit is ₹4,500.',
    evidenceWithDates(VIEWING_DOC),
  );
  assert.equal(result.allow, false, 'a fabricated price got through');
});

test('an invented percentage is still blocked', () => {
  const result = evaluateGrounding(
    'Book a viewing on Saturday and we will take 30% off the order.',
    evidenceWithDates(VIEWING_DOC),
  );
  assert.equal(result.allow, false, 'a fabricated percentage got through');
});

test('an invented quantity is still blocked', () => {
  const result = evaluateGrounding(
    'We have 37 showrooms across Karnataka.',
    evidenceWithDates(VIEWING_DOC),
  );
  assert.equal(result.allow, false, 'a fabricated quantity got through');
});

test('supplied dates do not ground an UNRELATED invented figure', () => {
  // The specific hole to avoid: the date block contains many numbers, and they
  // must not accidentally support a claim that has nothing to do with dates.
  const result = evaluateGrounding(
    'Your order total is ₹87,400 including installation.',
    evidenceWithDates(VIEWING_DOC),
  );
  assert.equal(result.allow, false, 'a price was grounded by the date block');
});
