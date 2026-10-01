import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COLD_START_CAP } from './types.js';
import { compositeConfidence, CONFIDENCE_WEIGHTS } from './confidence.js';

test('weights are 0.35 / 0.25 / 0.25 / 0.15', () => {
  assert.equal(CONFIDENCE_WEIGHTS.grounding, 0.35);
  assert.equal(CONFIDENCE_WEIGHTS.stateCompleteness, 0.25);
  assert.equal(CONFIDENCE_WEIGHTS.precedent, 0.25);
  assert.equal(CONFIDENCE_WEIGHTS.selfReport, 0.15);
});

test('cold start caps at 0.75 even when other terms are 1', () => {
  const result = compositeConfidence({
    grounding: 1,
    stateCompleteness: 1,
    precedent: 0,
    selfReport: 1,
  });
  assert.equal(result.coldStart, true);
  assert.equal(result.score, COLD_START_CAP);
  assert.ok(result.score <= 0.75);
});

test('warm precedent is a weighted sum, not capped', () => {
  const result = compositeConfidence({
    grounding: 1,
    stateCompleteness: 1,
    precedent: 1,
    selfReport: 1,
  });
  assert.equal(result.coldStart, false);
  assert.equal(result.score, 1);
});
