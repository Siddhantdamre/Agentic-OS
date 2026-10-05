/**
 * @jest-environment node
 *
 * When a request fails, the screen needs one plain sentence. `await res.json()` on a failed response throws
 * "Unexpected end of JSON input" when the body is empty, and that parser message used to land in a red box on
 * the last onboarding step. responseErrorMessage never throws and never shows internals.
 */
import { responseErrorMessage, DEFAULT_CLIENT_ERROR } from '@/lib/client-error';

const res = (status: number, body: unknown, jsonThrows = false) => ({
  status,
  json: jsonThrows ? () => Promise.reject(new SyntaxError('Unexpected end of JSON input')) : async () => body,
});

describe('responseErrorMessage', () => {
  it('uses the server’s own sentence from `message` or `error`', async () => {
    expect(await responseErrorMessage(res(409, { message: 'That name is taken.' }), 'fallback')).toBe('That name is taken.');
    expect(await responseErrorMessage(res(400, { error: 'Email is required' }), 'fallback')).toBe('Email is required');
  });

  it('prefers `message` when both are present', async () => {
    expect(await responseErrorMessage(res(400, { message: 'A', error: 'B' }), 'f')).toBe('A');
  });

  it('falls back when the body is empty or not JSON, without throwing', async () => {
    expect(await responseErrorMessage(res(500, null, true), 'We couldn’t save that. Please try again.')).toBe('We couldn’t save that. Please try again.');
  });

  it('falls back when the body has no usable text', async () => {
    expect(await responseErrorMessage(res(500, {}), 'fb')).toBe('fb');
    expect(await responseErrorMessage(res(500, { error: 42 }), 'fb')).toBe('fb');
    expect(await responseErrorMessage(res(500, 'plain'), 'fb')).toBe('fb');
  });

  it('never shows internal text: driver errors, hosts, setting names, stack frames', async () => {
    for (const text of ['relation "orgs" does not exist', 'connect ECONNREFUSED 10.0.0.2:5432', 'LANGFUSE_HOST must be set', 'boom\n    at Object.<anonymous> (/app/x.js:1:1)']) {
      expect(await responseErrorMessage(res(500, { message: text }), 'safe fallback')).toBe('safe fallback');
    }
  });

  it('answers a rate limit in words a person can act on', async () => {
    const msg = await responseErrorMessage(res(429, null, true), 'fb');
    expect(msg).toMatch(/wait|moment|too many|slow/i);
    expect(msg).not.toMatch(/429/);
  });

  it('answers an expired session in words a person can act on', async () => {
    expect(await responseErrorMessage(res(401, { error: 'Unauthorized' }), 'fb')).toMatch(/sign in/i);
  });

  it('has a sensible default when no fallback is given', async () => {
    expect(await responseErrorMessage(res(500, null, true))).toBe(DEFAULT_CLIENT_ERROR);
  });
});

import { networkErrorMessage, NETWORK_ERROR } from '@/lib/client-error';

describe('networkErrorMessage', () => {
  it('turns the browser’s own wording for a dropped connection into a plain sentence', () => {
    for (const e of [new TypeError('Failed to fetch'), new TypeError('NetworkError when attempting to fetch resource.'), new TypeError('Load failed'), new TypeError('Network request failed')]) {
      expect(networkErrorMessage(e, 'x')).toBe(NETWORK_ERROR);
    }
  });

  it('keeps one of our own sentences, and falls back for anything else', () => {
    expect(networkErrorMessage(new Error('Decision failed'), 'x')).toBe('Decision failed');
    expect(networkErrorMessage('boom', 'fallback')).toBe('fallback');
    expect(networkErrorMessage(undefined, 'fallback')).toBe('fallback');
  });

  it('never shows an internal detail', () => {
    expect(networkErrorMessage(new Error('connect ECONNREFUSED 10.0.0.5:5432'), 'fallback')).toBe('fallback');
  });
});
