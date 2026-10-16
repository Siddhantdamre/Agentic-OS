import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeWithTimeout } from './tool-executor.js';
import {
  fetchWithTimeout,
  runWithToolSignal,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_HTTP_TIMEOUT_MS,
} from './tools/shared.js';

function hangingServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer(() => {
      // never respond
    });
    server.on('connection', (s) => sockets.add(s));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

test('provider HTTP timeout never exceeds the executor deadline', () => {
  assert.ok(TOOL_HTTP_TIMEOUT_MS <= TOOL_EXECUTION_TIMEOUT_MS);
});

test('executeWithTimeout aborts the signal it handed out', async () => {
  let seen: AbortSignal | undefined;
  await assert.rejects(
    executeWithTimeout(
      (signal) => {
        seen = signal;
        return new Promise(() => {});
      },
      30,
      'Tool slow',
    ),
    /exceeded execution timeout/,
  );
  assert.equal(seen?.aborted, true);
});

test('fetchWithTimeout stops when the ambient tool signal aborts', async () => {
  const srv = await hangingServer();
  try {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(runWithToolSignal(controller.signal, () => fetchWithTimeout(srv.url, {}, 10_000)));
    assert.ok(Date.now() - started < 2000, 'request should stop on abort, not on the 10s timeout');
  } finally {
    srv.close();
  }
});

test('executor timeout aborts an in-flight provider fetch', async () => {
  const srv = await hangingServer();
  try {
    const started = Date.now();
    let fetchErr: unknown = null;
    await assert.rejects(
      executeWithTimeout(
        (signal) =>
          runWithToolSignal(signal, () =>
            fetchWithTimeout(srv.url, {}, 10_000).catch((err) => {
              fetchErr = err;
              throw err;
            }),
          ),
        50,
        'Tool hang',
      ),
      /exceeded execution timeout/,
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fetchErr, 'the underlying fetch must be aborted');
    assert.ok(Date.now() - started < 2000);
  } finally {
    srv.close();
  }
});
