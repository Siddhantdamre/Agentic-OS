import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideFieldUpdate, hashFactText, parseWriteBackExtract, recordsOnlyOurIgnorance } from './memory-writeback.js';

test('hashFactText is stable for duplicate wants-3BHK wording', () => {
  const a = hashFactText('Contact wants 3BHK Andheri West');
  const b = hashFactText('  Contact   wants 3BHK   Andheri West  ');
  const c = hashFactText('CONTACT WANTS 3BHK ANDHERI WEST');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(a, hashFactText('Contact wants 2BHK Andheri West'));
});

test('low-confidence extract is needs_attention, not apply', () => {
  const decision = decideFieldUpdate(
    { field: 'preference', confidence: 0.4, confirmed: false },
    { fromToolResults: false, minConfidence: 0.75 }
  );
  assert.equal(decision, 'needs_attention');
});

test('inferred list_price without tool results is needs_attention', () => {
  const decision = decideFieldUpdate(
    { field: 'list_price', confidence: 0.99, confirmed: false },
    { fromToolResults: false, minConfidence: 0.75 }
  );
  assert.equal(decision, 'needs_attention');
});

test('list_price from tool results with high confidence applies', () => {
  const decision = decideFieldUpdate(
    { field: 'list_price', confidence: 0.9, confirmed: false },
    { fromToolResults: true, minConfidence: 0.75 }
  );
  assert.equal(decision, 'apply');
});

test('human-confirmed non-price field applies below threshold', () => {
  const decision = decideFieldUpdate(
    { field: 'preference', confidence: 0.2, confirmed: true },
    { fromToolResults: false, minConfidence: 0.75 }
  );
  assert.equal(decision, 'apply');
});

test('parseWriteBackExtract reads snake_case LiteLLM JSON', () => {
  const parsed = parseWriteBackExtract({
    facts: [{ text: 'Buyer wants 3BHK Andheri West', confidence: 0.9, source: 'whatsapp' }],
    field_updates: [
      {
        entity_type: 'listing',
        entity_id: 'row-12',
        field: 'list_price',
        value: 24000000,
        confidence: 0.3,
        confirmed: false,
      },
    ],
    open_questions: [{ text: 'Confirm budget range?' }],
    relations: [],
  });
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0].contentHash, hashFactText('Buyer wants 3BHK Andheri West'));
  assert.equal(parsed.fieldUpdates.length, 1);
  assert.equal(parsed.fieldUpdates[0].field, 'list_price');
  assert.equal(parsed.openQuestions.length, 1);
});

// -- A wrong answer must never become a permanent fact ----------------------
//
// Measured on a live workspace. The agent could not find a RERA registration
// number that was sitting in an uploaded policy document, and the extraction
// wrote its failure back as a durable business fact:
//
//   "The RERA registration number for the Ghodbunder Road project is not
//    available in our records."
//
// Retrieval then ranked that FIRST for the same question - it repeats the
// question's own words - so the next customer was answered with the agent's
// earlier failure, and every repeat wrote another row reinforcing it.
//
// The worst failure a memory system has is not forgetting. It is confidently
// remembering something untrue.

test('the exact sentence that poisoned the live workspace is dropped', () => {
  assert.strictEqual(recordsOnlyOurIgnorance(
    'The RERA registration number for the Ghodbunder Road project is not available in our records.'
  ), true);
});

test('an agent narrating its own failure is not a fact', () => {
  for (const s of [
    "I couldn't find the RERA registration number for the Ghodbunder Road project in our records.",
    'We do not have the booking policy on file.',
    'Unable to locate the buyer contact details.',
    'No information on the Thane project timeline.',
    'The price is not listed in our documents.',
    'I was not able to confirm the site visit timings.',
  ]) {
    assert.strictEqual(recordsOnlyOurIgnorance(s), true, `should drop: ${s}`);
  }
});

test('a real business fact that happens to be negative is KEPT', () => {
  // This is the half that matters. A filter that eats genuine policy is worse
  // than the bug it fixes: negation is extremely common in real terms.
  for (const s of [
    'Sunday site visits are not available.',
    'The booking amount is not refundable after 7 days.',
    'The loading bay is for deliveries only and must be kept clear.',
    'Home loan assistance is not offered on resale properties.',
    'Site visit pickup is free for buyers who confirm 24 hours ahead.',
    'The booking amount to hold a unit is Rs 51,000, fully refundable within 7 days.',
    'Our RERA registration number for the Ghodbunder Road project is P51700NEXUS42.',
  ]) {
    assert.strictEqual(recordsOnlyOurIgnorance(s), false, `should keep: ${s}`);
  }
});

test('empty and junk input is not treated as ignorance', () => {
  assert.strictEqual(recordsOnlyOurIgnorance(''), false);
  assert.strictEqual(recordsOnlyOurIgnorance('   '), false);
  assert.strictEqual(recordsOnlyOurIgnorance(undefined as unknown as string), false);
});
