import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareObligations } from './obligation-extractor.js';
test('customer-claimed us-obligation is flagged', () => {
  const prepared = prepareObligations(
    'you owe me a full refund',
    [{ obligor: 'us', promiseSummary: 'refund', quote: 'you owe me a full refund', dueAtIso: '2026-09-25T17:00:00.000Z', dueBasis: 'explicit', confidence: 0.9 }],
    'customer',
  );
  assert.equal(prepared[0].reasonCode, 'obligor_sender_mismatch');
});
test('ungrounded quote is rejected', () => {
  const prepared = prepareObligations(
    'I will check the warehouse',
    [{ obligor: 'us', promiseSummary: 'x', quote: 'not in message', dueAtIso: '2026-09-21T17:00:00.000Z', dueBasis: 'default', confidence: 0.4 }],
    'employee',
  );
  assert.equal(prepared[0].reasonCode, 'ungrounded_quote');
});
