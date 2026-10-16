import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { runDsrDelete, tablesWithRemainingRows } from './run-delete.js';
import { DSR_DELETE_TABLES } from './tables.js';

type Call = { sql: string; params: unknown[] };

function fakeClient(opts: { leftover?: Record<string, number> }) {
  const calls: Call[] = [];
  const left = { ...(opts.leftover ?? {}) };
  let progress: unknown = {};
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/^\s*SELECT progress/.test(sql)) return { rows: [{ progress }], rowCount: 1 };
      if (/^\s*SELECT COUNT/.test(sql)) {
        const table = /FROM (\w+) WHERE/.exec(sql)![1];
        return { rows: [{ n: String(left[table] ?? 0) }], rowCount: 1 };
      }
      if (/^\s*DELETE FROM/.test(sql)) return { rows: [], rowCount: 1 };
      if (/UPDATE dsr_requests/.test(sql)) {
        const p = params.find((x) => typeof x === 'string' && x.startsWith('{'));
        if (typeof p === 'string') progress = JSON.parse(p);
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

test('tablesWithRemainingRows reports only non-empty tables', async () => {
  const { client } = fakeClient({ leftover: { messages: 3 } });
  const out = await tablesWithRemainingRows(client, 'org-1', ['messages', 'facts']);
  assert.deepEqual(out, { messages: 3 });
});

test('runDsrDelete completes when every table is empty after the sweep', async () => {
  const { client, calls } = fakeClient({});
  const res = await runDsrDelete(client, { orgId: 'org-1', dsrRequestId: 'dsr-1', requestedByUserId: 'u1' });
  assert.equal(res.status, 'completed');
  assert.ok(calls.some((c) => /status = 'completed'/.test(c.sql)));
});

test('every running save stamps heartbeatAt so the stale-job reaper can tell live from dead', async () => {
  const { client, calls } = fakeClient({});
  await runDsrDelete(client, { orgId: 'org-1', dsrRequestId: 'dsr-1', requestedByUserId: 'u1' });
  const running = calls.filter((c) => /status = 'running'/.test(c.sql));
  assert.ok(running.length > 0);
  assert.ok(running.every((c) => /heartbeatAt/.test(c.sql)));
});

test('runDsrDelete refuses to complete and reopens tables that still hold rows', async () => {
  const { client, calls } = fakeClient({ leftover: { messages: 2 } });
  await assert.rejects(
    runDsrDelete(client, { orgId: 'org-1', dsrRequestId: 'dsr-1', requestedByUserId: 'u1' }),
    /messages=2/
  );
  assert.ok(!calls.some((c) => /status = 'completed'/.test(c.sql)));
  const lastSave = [...calls].reverse().find((c) => /UPDATE dsr_requests/.test(c.sql));
  const saved = JSON.parse(String(lastSave!.params.find((x) => typeof x === 'string' && String(x).startsWith('{'))));
  assert.ok(!saved.doneTables.includes('messages'));
  assert.ok(saved.doneTables.length === DSR_DELETE_TABLES.length - 1);
});

test('runDsrDelete erases the Hindsight bank before completing', async () => {
  const realFetch = globalThis.fetch;
  process.env.HINDSIGHT_URL = 'http://hindsight.test:8888';
  const seen: Array<{ url: string; method?: string }> = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const { client, calls } = fakeClient({});
    await runDsrDelete(client, { orgId: 'org-1', dsrRequestId: 'dsr-1', requestedByUserId: 'u1' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'DELETE');
    assert.ok(seen[0].url.endsWith('/v1/default/banks/org_org-1'));
    assert.ok(calls.some((c) => /status = 'completed'/.test(c.sql)));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.HINDSIGHT_URL;
  }
});

test('runDsrDelete stays running when the Hindsight delete fails', async () => {
  const realFetch = globalThis.fetch;
  process.env.HINDSIGHT_URL = 'http://hindsight.test:8888';
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  try {
    const { client, calls } = fakeClient({});
    await assert.rejects(
      runDsrDelete(client, { orgId: 'org-1', dsrRequestId: 'dsr-1', requestedByUserId: 'u1' }),
      /Hindsight bank delete failed: HTTP 500/
    );
    assert.ok(!calls.some((c) => /status = 'completed'/.test(c.sql)));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.HINDSIGHT_URL;
  }
});

test('runDsrDelete erases the Cognee dataset and stays running if that fails', async () => {
  const realFetch = globalThis.fetch;
  process.env.COGNEE_URL = 'http://cognee.test:8000';
  let deleteStatus = 200;
  const seen: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(url)}`);
    if (init?.method === 'DELETE') return new Response('boom', { status: deleteStatus });
    return new Response(JSON.stringify([{ id: 'ds-1', name: 'org_org-1' }]), { status: 200 });
  }) as typeof fetch;
  try {
    const ok = fakeClient({});
    await runDsrDelete(ok.client, { orgId: 'org-1', dsrRequestId: 'dsr-1', requestedByUserId: 'u1' });
    assert.ok(seen.some((s) => s.startsWith('DELETE ') && s.endsWith('/api/v1/datasets/ds-1')));
    assert.ok(ok.calls.some((c) => /status = 'completed'/.test(c.sql)));

    deleteStatus = 500;
    const bad = fakeClient({});
    await assert.rejects(
      runDsrDelete(bad.client, { orgId: 'org-1', dsrRequestId: 'dsr-2', requestedByUserId: 'u1' }),
      /Cognee dataset delete failed: HTTP 500/
    );
    assert.ok(!bad.calls.some((c) => /status = 'completed'/.test(c.sql)));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.COGNEE_URL;
  }
});
