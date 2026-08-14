import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KNOWN_BAD_FAIR_HOUSING_DRAFT,
  KNOWN_BAD_RERA_AD,
  validateOutboundDraft,
} from './compliance.js';

test('known-bad fair-housing draft is caught', () => {
  const result = validateOutboundDraft(KNOWN_BAD_FAIR_HOUSING_DRAFT, 'send');
  assert.equal(result.allow, false);
  assert.equal(result.policy, 'fair_housing');
});

test('India listing ad without RERA is blocked on publish', () => {
  const result = validateOutboundDraft(KNOWN_BAD_RERA_AD, 'publish');
  assert.equal(result.allow, false);
  assert.ok(result.policy === 'rera' || result.policy === 'legal_promise');
});
