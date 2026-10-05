import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deleteCogneeDataset,
  exportCognee,
  hasCogneeDataset,
  rememberCognee,
  resetCogneeDatasetCache,
  searchCognee,
} from './cognee-client.js';

type Captured = { url: string; init: RequestInit | undefined };

function stubFetch(responder: (url: string, init?: RequestInit) => Response): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('rememberCognee redacts secrets and card numbers before the text leaves the worker', async () => {
  const { calls, restore } = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    const ok = await rememberCognee({
      orgId: '11111111-1111-4111-8111-111111111111',
      text: 'Customer card 4111 1111 1111 1111 and key sk-or-abcdefghijklmnopqrstuvwxyz0123 were shared',
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    const body = calls[0].init?.body as FormData;
    const raw = String(body.get('raw_data'));
    assert.ok(!raw.includes('4111 1111 1111 1111'), 'card number must not reach Cognee');
    assert.ok(!raw.includes('sk-or-abcdefghijklmnopqrstuvwxyz0123'), 'api key must not reach Cognee');
    assert.ok(raw.includes('[REDACTED]'));
    assert.equal(body.get('datasetName'), 'org_11111111-1111-4111-8111-111111111111');
  } finally {
    restore();
  }
});

test('rememberCognee does not call Cognee when redaction leaves nothing', async () => {
  const { calls, restore } = stubFetch(() => new Response('{}', { status: 200 }));
  try {
    const ok = await rememberCognee({ orgId: '11111111-1111-4111-8111-111111111111', text: '   ' });
    assert.equal(ok, false);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

const ORG = '11111111-1111-4111-8111-111111111111';

test('deleteCogneeDataset finds the org dataset by name and deletes only that one', async () => {
  const { calls, restore } = stubFetch((url, init) =>
    init?.method === 'DELETE'
      ? new Response('{}', { status: 200 })
      : new Response(JSON.stringify([{ id: 'other-id', name: 'org_someone-else' }, { id: 'mine-id', name: `org_${ORG}` }]), { status: 200 }),
  );
  try {
    await deleteCogneeDataset(ORG);
    const del = calls.filter((c) => c.init?.method === 'DELETE');
    assert.equal(del.length, 1);
    assert.ok(del[0].url.endsWith('/api/v1/datasets/mine-id'));
  } finally {
    restore();
  }
});

test('deleteCogneeDataset: no dataset means nothing to delete, a failed delete throws', async () => {
  let datasets: unknown[] = [];
  let deleteStatus = 200;
  const { calls, restore } = stubFetch((url, init) =>
    init?.method === 'DELETE' ? new Response('boom', { status: deleteStatus }) : new Response(JSON.stringify(datasets), { status: 200 }),
  );
  try {
    await deleteCogneeDataset(ORG);
    assert.equal(calls.filter((c) => c.init?.method === 'DELETE').length, 0);
    datasets = [{ id: 'mine-id', name: `org_${ORG}` }];
    deleteStatus = 500;
    await assert.rejects(deleteCogneeDataset(ORG), /Cognee dataset delete failed: HTTP 500/);
  } finally {
    restore();
  }
});

test('exportCognee returns the dataset records, [] without a dataset, and throws on failure', async () => {
  let datasets: unknown[] = [{ id: 'mine-id', name: `org_${ORG}` }];
  let dataStatus = 200;
  const { restore } = stubFetch((url) =>
    url.endsWith('/data') ? new Response(JSON.stringify([{ id: 'r1', name: 'note' }]), { status: dataStatus }) : new Response(JSON.stringify(datasets), { status: 200 }),
  );
  try {
    assert.deepEqual(await exportCognee(ORG), [{ id: 'r1', name: 'note' }]);
    dataStatus = 500;
    await assert.rejects(exportCognee(ORG), /Cognee export failed: HTTP 500/);
    datasets = [];
    assert.deepEqual(await exportCognee(ORG), []);
  } finally {
    restore();
  }
});

const DS_ORG = '22222222-2222-4222-8222-222222222222';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('hasCogneeDataset: an empty dataset list means no memory yet, and search skips Cognee', async () => {
  resetCogneeDatasetCache();
  const { calls, restore } = stubFetch(() => json([]));
  try {
    assert.equal(await hasCogneeDataset(DS_ORG), false);
    assert.deepEqual(await searchCognee({ orgId: DS_ORG, query: 'who is the owner' }), []);
    assert.ok(calls.every((c) => !c.url.includes('/api/v1/search')), 'no /search call without a dataset');
  } finally {
    restore();
  }
});

test('hasCogneeDataset: the org dataset is found by exact name, others do not count', async () => {
  resetCogneeDatasetCache();
  const { restore } = stubFetch(() => json([{ id: 'a', name: 'org_someone-else' }, { id: 'b', name: `org_${DS_ORG}` }]));
  try {
    assert.equal(await hasCogneeDataset(DS_ORG), true);
    resetCogneeDatasetCache();
    assert.equal(await hasCogneeDataset('33333333-3333-4333-8333-333333333333'), false);
  } finally {
    restore();
  }
});

test('hasCogneeDataset: a present dataset lets the search run', async () => {
  resetCogneeDatasetCache();
  const { calls, restore } = stubFetch((url) => (url.includes('/api/v1/datasets') ? json([{ id: 'b', name: `org_${DS_ORG}` }]) : json([])));
  try {
    await searchCognee({ orgId: DS_ORG, query: 'who is the owner' });
    assert.ok(calls.some((c) => c.url.includes('/api/v1/search')), 'search must reach Cognee when the dataset exists');
  } finally {
    restore();
  }
});

test('hasCogneeDataset: any doubt searches anyway (HTTP error, thrown fetch, odd shape)', async () => {
  for (const responder of [
    () => json({ detail: 'boom' }, 500),
    () => { throw new Error('connect ECONNREFUSED'); },
    () => json(['org_x']),
    () => json({ datasets: [] }),
  ]) {
    resetCogneeDatasetCache();
    const { restore } = stubFetch(responder as () => Response);
    try {
      assert.equal(await hasCogneeDataset(DS_ORG), true);
    } finally {
      restore();
    }
  }
});

test('hasCogneeDataset: a cached "no" is re-checked after a few seconds, a cached "yes" is not refetched', async () => {
  resetCogneeDatasetCache();
  let listed: Array<{ name: string }> = [];
  const { calls, restore } = stubFetch(() => json(listed));
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    assert.equal(await hasCogneeDataset(DS_ORG), false);
    assert.equal(await hasCogneeDataset(DS_ORG), false);
    assert.equal(calls.length, 1, 'a fresh "no" is served from the cache');
    listed = [{ name: `org_${DS_ORG}` }];
    now += 6_000;
    assert.equal(await hasCogneeDataset(DS_ORG), true, 'created by another process: found after the recheck window');
    assert.equal(calls.length, 2);
    assert.equal(await hasCogneeDataset(DS_ORG), true);
    assert.equal(calls.length, 2, 'a cached "yes" is not refetched');
  } finally {
    Date.now = realNow;
    restore();
  }
});

test('rememberCognee marks the dataset present so the next search is not skipped', async () => {
  resetCogneeDatasetCache();
  const { restore } = stubFetch((url) => (url.includes('/api/v1/datasets') ? json([{ name: 'org_other' }]) : json({}, 200)));
  try {
    assert.equal(await hasCogneeDataset(DS_ORG), false);
    assert.equal(await rememberCognee({ orgId: DS_ORG, text: 'The owner is Priya' }), true);
    assert.equal(await hasCogneeDataset(DS_ORG), true);
  } finally {
    restore();
  }
});

test('deleteCogneeDataset keeps the dataset marked present when the delete fails', async () => {
  resetCogneeDatasetCache();
  const { restore } = stubFetch((url, init) => {
    if (init?.method === 'DELETE') return json({ detail: 'nope' }, 500);
    return json([{ id: 'd1', name: `org_${DS_ORG}` }]);
  });
  try {
    assert.equal(await hasCogneeDataset(DS_ORG), true);
    await assert.rejects(() => deleteCogneeDataset(DS_ORG));
    assert.equal(await hasCogneeDataset(DS_ORG), true, 'a failed delete must not hide the memory');
  } finally {
    restore();
  }
});
