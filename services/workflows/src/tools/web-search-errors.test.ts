import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { failureOf } from './search-providers.js';
import { searchLive, webSearch } from './web-search.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.JINA_API_KEY;
});

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request) => handler(String(input instanceof Request ? input.url : input))) as typeof fetch;
}

const status = (code: number) => new Response('', { status: code });

test('every provider rate-limited is a rate_limited failure, not an empty result', async () => {
  process.env.JINA_API_KEY = 'test';
  const { results, attempts } = await searchLive('Acme Robotics funding', fakeFetch(() => status(429)));
  assert.equal(results.length, 0);
  assert.deepEqual(attempts.map((a) => a.provider).sort(), ['duckduckgo', 'google_news', 'jina', 'wikipedia']);
  assert.equal(failureOf(attempts), 'rate_limited');
});

test('a bot challenge and network errors are reported as such', async () => {
  const { attempts } = await searchLive('Acme Robotics funding', fakeFetch((url) => {
    if (url.includes('duckduckgo')) return new Response('<div class="anomaly-modal"></div>', { status: 200 });
    throw new Error('getaddrinfo ENOTFOUND');
  }));
  assert.equal(attempts.find((a) => a.provider === 'duckduckgo')?.error?.reason, 'blocked');
  assert.equal(attempts.find((a) => a.provider === 'wikipedia')?.error?.detail, 'getaddrinfo ENOTFOUND');
  assert.equal(failureOf(attempts), 'provider_unavailable');
});

test('one provider answering with nothing means the web was checked', async () => {
  const { results, attempts } = await searchLive('Acme Robotics funding', fakeFetch((url) => {
    if (url.includes('wikipedia')) return Response.json({ query: { search: [] } });
    return status(503);
  }));
  assert.equal(results.length, 0);
  assert.equal(failureOf(attempts), null);
});

test('web_search returns status error with a reason when providers are down', async () => {
  globalThis.fetch = fakeFetch(() => status(429));
  const out = await webSearch.execute({ payload: { query: 'Acme Robotics funding' }, timestamp: 't' } as never) as {
    status: string; message: string; data: { reason?: string; results: unknown[]; providers: Array<{ error?: string }> };
  };
  assert.equal(out.status, 'error');
  assert.equal(out.data.reason, 'rate_limited');
  assert.deepEqual(out.data.results, []);
  assert.ok(out.data.providers.every((p) => p.error === 'rate_limited'));
  assert.doesNotMatch(out.message, /No web search results found/);
  assert.match(out.message, /not a "no results" answer/);
});

test('web_search returns executed with no results when the web had nothing', async () => {
  globalThis.fetch = fakeFetch((url) => (url.includes('wikipedia') ? Response.json({ query: { search: [] } }) : status(500)));
  const out = await webSearch.execute({ payload: { query: 'Acme Robotics funding' }, timestamp: 't' } as never) as {
    status: string; message: string; data: { reason?: string };
  };
  assert.equal(out.status, 'executed');
  assert.equal(out.data.reason, undefined);
  assert.match(out.message, /No web search results found/);
});
