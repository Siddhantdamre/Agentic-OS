import { test } from 'node:test';
import assert from 'node:assert/strict';
import { obligorSenderMismatch, quoteIsGrounded } from './obligation-checks.js';
test('grounding and mismatch', () => {
  assert.equal(quoteIsGrounded('hi', 'say hi now'), true);
  assert.equal(obligorSenderMismatch('us', 'customer'), true);
});
