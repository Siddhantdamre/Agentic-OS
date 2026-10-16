import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLazyConnector } from './temporal-connect.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('connects once and hands the same client to every later caller', async () => {
  let connects = 0;
  const get = createLazyConnector({ connect: async () => ({ id: ++connects }), timeoutMs: 100, backoffMs: 1000 });
  const a = await get();
  const b = await get();
  assert.equal(connects, 1);
  assert.equal(a, b);
});

test('gives up on a connect that hangs, and answers null instead of waiting forever', async () => {
  const get = createLazyConnector({ connect: () => new Promise<never>(() => {}), timeoutMs: 30, backoffMs: 1000 });
  const t0 = Date.now();
  assert.equal(await get(), null);
  assert.ok(Date.now() - t0 < 500, 'should answer shortly after the timeout');
});

test('a rejected connect answers null and does not throw', async () => {
  const get = createLazyConnector({ connect: async () => { throw new Error('ECONNREFUSED'); }, timeoutMs: 100, backoffMs: 1000 });
  assert.equal(await get(), null);
});

test('after a failure it does not try again during the back-off window, so only one request pays the wait', async () => {
  const c = clock();
  let connects = 0;
  const get = createLazyConnector({
    connect: async () => { connects++; throw new Error('down'); },
    timeoutMs: 100,
    backoffMs: 10_000,
    now: c.now,
  });
  assert.equal(await get(), null);
  assert.equal(connects, 1);
  c.advance(9_999);
  const t0 = Date.now();
  assert.equal(await get(), null);
  assert.equal(await get(), null);
  assert.equal(connects, 1, 'no new attempt inside the window');
  assert.ok(Date.now() - t0 < 50, 'answers at once inside the window');
});

test('it tries again once the back-off window has passed, and recovers when the cluster is back', async () => {
  const c = clock();
  let up = false;
  let connects = 0;
  const get = createLazyConnector({
    connect: async () => { connects++; if (!up) throw new Error('down'); return { ok: true }; },
    timeoutMs: 100,
    backoffMs: 10_000,
    now: c.now,
  });
  assert.equal(await get(), null);
  up = true;
  c.advance(10_001);
  assert.deepEqual(await get(), { ok: true });
  assert.equal(connects, 2);
});

test('callers that arrive during one attempt share it', async () => {
  let connects = 0;
  const get = createLazyConnector({
    connect: async () => { connects++; await sleep(20); return { ok: true }; },
    timeoutMs: 200,
    backoffMs: 1000,
  });
  const [a, b, c] = await Promise.all([get(), get(), get()]);
  assert.equal(connects, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

test('a connect that finishes after its timeout does not become the cached client', async () => {
  let connects = 0;
  const get = createLazyConnector({
    connect: async () => { connects++; await sleep(60); return { late: true }; },
    timeoutMs: 20,
    backoffMs: 1,
  });
  assert.equal(await get(), null);
  await sleep(80);
  await sleep(5);
  // the late connection is discarded; the next call (back-off long passed) makes a fresh attempt
  const second = await get();
  assert.equal(connects, 2);
  assert.ok(second === null || second.late === true);
});
