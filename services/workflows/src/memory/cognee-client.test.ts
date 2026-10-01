import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteCogneeDataset, exportCognee, rememberCognee } from './cognee-client.js';

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
