import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConfidenceGate } from './confidence-gate.js';
test('low rag and no tool forces escalate', () => {
  assert.equal(evaluateConfidenceGate({ topSimilarity: 0.4, toolHit: false }).allow, false);
});
test('tool hit allows even with low rag', () => {
  assert.equal(evaluateConfidenceGate({ topSimilarity: 0.4, toolHit: true }).allow, true);
});
