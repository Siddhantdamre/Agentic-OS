import test from 'node:test';
import assert from 'node:assert';

import { isQuotaExhausted } from './embed';

test('a spent daily quota is told apart from a per-minute throttle', () => {
  // Exhaustion: retrying today cannot succeed, so it must not be retried.
  // The first string is the real Gemini body, from the worker log.
  for (const body of [
    'You exceeded your current quota, please check your plan and billing details.',
    '{"error":{"code":429,"message":"You exceeded your current quota"}}',
    'insufficient_quota',
  ]) {
    assert.equal(isQuotaExhausted(body), true, body);
  }
  // A throttle clears in seconds. Treating it as exhaustion would discard work
  // that a two-second wait would have saved, so anything ambiguous stays
  // retryable.
  for (const body of ['Rate limit reached for requests. Please try again in 2s.', '429 Too Many Requests', '']) {
    assert.equal(isQuotaExhausted(body), false, body);
  }
});
