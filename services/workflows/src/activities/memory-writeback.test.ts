import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideFieldUpdate, hashFactText, parseWriteBackExtract } from './memory-writeback.js';

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
