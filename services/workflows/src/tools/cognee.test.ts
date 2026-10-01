import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cognee } from './cognee.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const ctx = (action: string, payload: Record<string, unknown>) =>
  ({ tool: 'cognee', action, actionName: action, payload, orgId: ORG, timestamp: 't' }) as Parameters<typeof cognee.execute>[0];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.USE_COGNEE;
  delete process.env.USE_HINDSIGHT;
});

function stub(cogneeRes: () => Response, hindsightRes: () => Response) {
  globalThis.fetch = (async (input: unknown) =>
    String(input).includes('/api/v1/') ? cogneeRes() : hindsightRes()) as typeof fetch;
}
const cogneeGraph = (text: string) =>
  new Response(JSON.stringify([`__node_content_start__ ${text} __node_content_end__`]), { status: 200 });
const hindsightHits = (...t: string[]) =>
  new Response(JSON.stringify({ results: t.map((text, i) => ({ id: String(i), text })) }), { status: 200 });

test('search merges both backends and dedupes identical snippets', async () => {
  stub(() => cogneeGraph('Ravi wants 2BHK in Baner'), () => hindsightHits('Ravi wants 2BHK in Baner', 'Budget is 85 lakh'));
  const out: any = await cognee.execute(ctx('search', { query: 'Ravi' }));
  assert.equal(out.status, 'executed');
  assert.deepEqual(out.data.facts, ['Ravi wants 2BHK in Baner', 'Budget is 85 lakh']);
  assert.deepEqual(out.data.citations.map((c: any) => c.id), ['G-1', 'G-2']);
});

test('search keeps working when one backend is down, errors only when all enabled are down', async () => {
  stub(() => new Response('boom', { status: 500 }), () => hindsightHits('Budget is 85 lakh'));
  let out: any = await cognee.execute(ctx('search', { query: 'Ravi' }));
  assert.equal(out.status, 'executed');
  assert.equal(out.data.citations.length, 1);

  stub(() => new Response('boom', { status: 500 }), () => new Response('boom', { status: 500 }));
  out = await cognee.execute(ctx('search', { query: 'Ravi' }));
  assert.equal(out.status, 'error');

  // Disabled backend must not mask the other one failing as "no results".
  process.env.USE_COGNEE = 'false';
  out = await cognee.execute(ctx('search', { query: 'Ravi' }));
  assert.equal(out.status, 'error');
});

test('remember succeeds if either backend accepts it', async () => {
  stub(() => new Response('boom', { status: 500 }), () => new Response('{}', { status: 200 }));
  const out: any = await cognee.execute(ctx('remember', { text: 'Ravi prefers WhatsApp' }));
  assert.equal(out.status, 'executed');
  assert.equal(out.data.cognee, false);
  assert.equal(out.data.hindsight, true);
});
