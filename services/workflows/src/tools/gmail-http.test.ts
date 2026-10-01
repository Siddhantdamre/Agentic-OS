import assert from 'node:assert/strict';
import test from 'node:test';
import { gmailHttpFailure } from './gmail.js';

test('gmail 401 is revoked, not an empty inbox', () => {
  const result = gmailHttpFailure('fetch_latest_emails', '2026-09-27T00:00:00.000Z', 401);
  assert.equal(result.status, 'error');
  assert.equal(result.data?.reason, 'revoked');
});

test('gmail 500 is an api error', () => {
  const result = gmailHttpFailure('fetch_latest_emails', '2026-09-27T00:00:00.000Z', 500);
  assert.equal(result.status, 'error');
  assert.equal(result.data?.reason, 'api_error');
});
