import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateCriticDraft,
  KNOWN_BAD_FAIR_HOUSING_DRAFT,
} from './critic-check.js';

test('known-bad fair-housing draft is blocked', () => {
  const result = evaluateCriticDraft(KNOWN_BAD_FAIR_HOUSING_DRAFT, 'send');
  assert.equal(result.allow, false);
  assert.equal(result.policy, 'fair_housing');
  assert.match(result.reason, /fair housing/i);
  assert.ok(result.violations.length > 0);
});

test('clean FAQ draft is allowed', () => {
  const result = evaluateCriticDraft(
    'Thanks for writing in. Your showing is confirmed for Tuesday at 3pm. Reply STOP to opt out.',
    'send'
  );
  assert.equal(result.allow, true);
  assert.equal(result.policy, 'ok');
});

test('guaranteed returns are blocked as a legal promise', () => {
  const result = evaluateCriticDraft(
    'Invest now — guaranteed 12% yield on this listing.',
    'publish'
  );
  assert.equal(result.allow, false);
  assert.equal(result.policy, 'legal_promise');
});

test('India listing ad without RERA is blocked on publish', () => {
  const result = evaluateCriticDraft(
    'New 2BHK for sale in Mumbai. Book now.',
    'publish'
  );
  assert.equal(result.allow, false);
  assert.equal(result.policy, 'rera');
});
