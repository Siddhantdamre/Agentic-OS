import assert from 'node:assert/strict';
import test from 'node:test';
import { gmailHttpFailure, gmailListUrl } from './gmail.js';

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

test('gmail search passes the query as q, encoded, and clamps the count (TOOL-G01)', () => {
  const url = new URL(gmailListUrl(5, '  from:alice@acme.com subject:"Q3 invoice" '));
  assert.equal(url.searchParams.get('q'), 'from:alice@acme.com subject:"Q3 invoice"');
  assert.equal(url.searchParams.get('maxResults'), '5');
  assert.equal(new URL(gmailListUrl(500)).searchParams.get('maxResults'), '50');
  assert.equal(new URL(gmailListUrl('x')).searchParams.get('maxResults'), '10');
  assert.equal(new URL(gmailListUrl(10, '   ')).searchParams.has('q'), false);
  assert.equal(new URL(gmailListUrl(10, 'a'.repeat(900))).searchParams.get('q')?.length, 500);
});
