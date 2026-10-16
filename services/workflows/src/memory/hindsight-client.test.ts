import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteHindsightBank, exportHindsight, listHindsight, retainHindsight, searchHindsight } from './hindsight-client.js';

const ORG = '11111111-1111-4111-8111-111111111111';

function stubFetch(responder: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responder(String(input), init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('retainHindsight redacts secrets and targets the org bank', async () => {
  const { calls, restore } = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    const ok = await retainHindsight({
      orgId: ORG,
      text: 'Customer card 4111 1111 1111 1111 and key sk-or-abcdefghijklmnopqrstuvwxyz0123 were shared',
      documentId: 'conv-1',
    });
    assert.equal(ok, true);
    // First retain for an org configures the bank missions once, then retains.
    assert.ok(calls[0].url.endsWith(`/v1/default/banks/org_${ORG}/config`));
    assert.equal(calls[0].init?.method, 'PATCH');
    assert.ok(JSON.parse(String(calls[0].init?.body)).updates.retain_mission);
    const retain = calls[calls.length - 1];
    assert.ok(retain.url.endsWith(`/v1/default/banks/org_${ORG}/memories`));
    const body = JSON.parse(String(retain.init?.body));
    assert.equal(body.async, true);
    assert.equal(body.items[0].document_id, 'conv-1');
    assert.ok(!body.items[0].content.includes('4111 1111 1111 1111'));
    assert.ok(!body.items[0].content.includes('sk-or-abcdefghijklmnopqrstuvwxyz0123'));
  } finally {
    restore();
  }
});

test('retainHindsight skips blank text without calling the API', async () => {
  const { calls, restore } = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    assert.equal(await retainHindsight({ orgId: ORG, text: '  ' }), false);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('searchHindsight maps recall results to graph-tier citations', async () => {
  const { restore } = stubFetch(
    () => new Response(JSON.stringify({ results: [{ id: 'a', text: 'Ravi prefers 2BHK in Baner', mentioned_at: '2026-09-01T00:00:00Z' }, { id: 'b', text: '  ' }] }), { status: 200 }),
  );
  try {
    const out = await searchHindsight({ orgId: ORG, query: 'Ravi budget' });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'G-1');
    assert.equal(out[0].tier, 'graph');
    assert.equal(out[0].sourceRef, `hindsight:org_${ORG}`);
  } finally {
    restore();
  }
});

test('searchHindsight: 404 is an empty bank, 500 throws', async () => {
  let status = 404;
  const { restore } = stubFetch(() => new Response('nope', { status }));
  try {
    assert.deepEqual(await searchHindsight({ orgId: ORG, query: 'x' }), []);
    status = 500;
    await assert.rejects(searchHindsight({ orgId: ORG, query: 'x' }), /Hindsight recall failed: HTTP 500/);
  } finally {
    restore();
  }
});

test('bank missions are set once per org, not on every retain', async () => {
  const { calls, restore } = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    const org = '22222222-2222-4222-8222-222222222222';
    await retainHindsight({ orgId: org, text: 'first fact' });
    await retainHindsight({ orgId: org, text: 'second fact' });
    assert.equal(calls.filter((c) => c.init?.method === 'PATCH').length, 1);
    assert.equal(calls.filter((c) => c.url.endsWith('/memories')).length, 2);
  } finally {
    restore();
  }
});

test('a failed mission config does not block the retain', async () => {
  const { calls, restore } = stubFetch((url) => new Response('{}', { status: url.endsWith('/config') ? 500 : 200 }));
  try {
    const ok = await retainHindsight({ orgId: '33333333-3333-4333-8333-333333333333', text: 'a fact' });
    assert.equal(ok, true);
    assert.ok(calls.some((c) => c.url.endsWith('/memories')));
  } finally {
    restore();
  }
});

test('deleteHindsightBank: 404 is fine, 500 throws, and the next retain re-applies missions', async () => {
  let status = 404;
  const { calls, restore } = stubFetch(() => new Response('{}', { status }));
  try {
    const org = '55555555-5555-4555-8555-555555555555';
    await retainHindsight({ orgId: org, text: 'fact' });
    await deleteHindsightBank(org);
    status = 500;
    await assert.rejects(deleteHindsightBank(org), /Hindsight bank delete failed: HTTP 500/);
    status = 200;
    await retainHindsight({ orgId: org, text: 'fact again' });
    assert.equal(calls.filter((c) => c.init?.method === 'PATCH').length, 2);
  } finally {
    restore();
  }
});

test('exportHindsight pages through every memory unit and throws on failure', async () => {
  const pages = [
    { items: [{ id: 'a' }, { id: 'b' }], total: 3 },
    { items: [{ id: 'c' }], total: 3 },
  ];
  let n = 0;
  const { restore } = stubFetch(() => new Response(JSON.stringify(pages[n++]), { status: 200 }));
  try {
    assert.deepEqual((await exportHindsight(ORG)).map((x) => x.id), ['a', 'b', 'c']);
  } finally {
    restore();
  }
  const failing = stubFetch(() => new Response('x', { status: 500 }));
  try {
    await assert.rejects(exportHindsight(ORG), /Hindsight export failed: HTTP 500/);
  } finally {
    failing.restore();
  }
});

test('listHindsight maps facts, drops blanks, clamps the limit; 404 is empty, 500 throws', async () => {
  let status = 200;
  const { calls, restore } = stubFetch(
    () =>
      new Response(
        JSON.stringify({ items: [{ id: 'a', text: 'Budget is 85 lakh', fact_type: 'world', mentioned_at: '2026-09-30T00:00:00Z' }, { id: 'b', text: '   ' }] }),
        { status },
      ),
  );
  try {
    const out = await listHindsight(ORG, 9999);
    assert.deepEqual(out, [{ id: 'a', text: 'Budget is 85 lakh', type: 'world', updatedAt: '2026-09-30T00:00:00Z' }]);
    assert.ok(calls[0].url.includes(`/banks/org_${ORG}/memories/list?limit=100&offset=0`));
    status = 404;
    assert.deepEqual(await listHindsight(ORG), []);
    status = 500;
    await assert.rejects(listHindsight(ORG), /Hindsight list failed: HTTP 500/);
  } finally {
    restore();
  }
});
