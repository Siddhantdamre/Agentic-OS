import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyMemoryResult, toRetrieveActivityResult } from './retrieve.js';

test('empty retrieve maps to empty facts — never invented', () => {
  const mapped = toRetrieveActivityResult(emptyMemoryResult('11111111-1111-4111-8111-111111111111'));
  assert.equal(mapped.noOp, false);
  assert.equal(mapped.emptyIndex, true);
  assert.deepEqual(mapped.facts, []);
  assert.deepEqual(mapped.citations, []);
  assert.equal(mapped.facts.some((f) => /kapoor|listing|3bhk/i.test(f)), false);
});

test('citations become facts and ids without extra prose', () => {
  const mapped = toRetrieveActivityResult({
    orgId: '11111111-1111-4111-8111-111111111111',
    emptyIndex: false,
    citations: [
      {
        id: 'M-17',
        tier: 'entity',
        snippet: 'Priya last asked about 3BHK Andheri West',
        source: 'whatsapp',
        sourceRef: 'conv-1',
        stale: false,
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  });
  assert.equal(mapped.noOp, false);
  assert.equal(mapped.emptyIndex, false);
  assert.deepEqual(mapped.citations, ['M-17']);
  assert.deepEqual(mapped.facts, ['Priya last asked about 3BHK Andheri West']);
});
