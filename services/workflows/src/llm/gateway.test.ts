/**
 * COUNTING WHAT WAS ACTUALLY SPENT.
 *
 * `monitor_used_model` was hard-coded `false` on every supervision row. It is
 * the alarm that fires when the deterministic gates stop carrying their share
 * and the price per conversation triples — so a wrong value here is worse than
 * no value: it reads as "the cheap layer is handling everything" precisely when
 * it is not.
 *
 * The failures that matter are both directions of lying:
 *
 *   counting a REFUSED call        -> reports spend that never happened, and
 *                                     an over-budget tenant looks expensive
 *   missing a DISPATCHED call      -> the alarm never fires
 *   tallies bleeding between tasks -> one busy conversation makes every
 *                                     concurrent one look expensive
 *
 * Run: node --test dist/llm/gateway.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { countLlmCalls, llmChat, effectiveTimeoutMs } from './gateway';

const ORG = '11111111-1111-1111-1111-111111111111';

/** Configure the gateway so a call would dispatch, and stub the wire. */
function withStubbedProxy(handler: () => Promise<Response> | Response) {
  const prevUrl = process.env.LITELLM_BASE_URL;
  const prevKey = process.env.LITELLM_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.LITELLM_BASE_URL = 'http://litellm.test/v1';
  process.env.LITELLM_API_KEY = 'test-key';
  globalThis.fetch = (async () => handler()) as typeof fetch;
  return () => {
    if (prevUrl === undefined) delete process.env.LITELLM_BASE_URL;
    else process.env.LITELLM_BASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = prevKey;
    globalThis.fetch = prevFetch;
  };
}

const ok = () => new Response(
  JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

const chat = (over: Record<string, unknown> = {}) => llmChat({
  orgId: ORG,
  purpose: 'critic',
  // modelOverride skips budget resolution, so these tests exercise the counter
  // without needing a database.
  modelOverride: 'test-model',
  messages: [{ role: 'user', content: 'x' }],
  ...over,
} as Parameters<typeof llmChat>[0]);

test('a scope that dispatches nothing reports zero', async () => {
  const { dispatched } = await countLlmCalls(async () => 'no calls here');
  assert.equal(dispatched, 0);
});

test('the scope returns the inner value untouched', async () => {
  const { result } = await countLlmCalls(async () => ({ ok: true, n: 7 }));
  assert.deepEqual(result, { ok: true, n: 7 });
});

test('a dispatched call is counted', async () => {
  const restore = withStubbedProxy(ok);
  try {
    const { dispatched } = await countLlmCalls(async () => { await chat(); });
    assert.equal(dispatched, 1);
  } finally { restore(); }
});

test('REFUSED CALLS ARE NOT COUNTED: an unconfigured proxy spends nothing', async () => {
  // The most important direction. A tally that counted calls the gateway
  // refused would report spend that never happened.
  const prevUrl = process.env.LITELLM_BASE_URL;
  const prevKey = process.env.LITELLM_API_KEY;
  const prevMaster = process.env.LITELLM_MASTER_KEY;
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';   // makes the base url default to empty
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_API_KEY;
  delete process.env.LITELLM_MASTER_KEY;
  try {
    const { dispatched } = await countLlmCalls(async () => {
      const res = await chat();
      assert.equal(res.error, 'not_configured');
    });
    assert.equal(dispatched, 0, 'a call that never left the process is not spend');
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevUrl !== undefined) process.env.LITELLM_BASE_URL = prevUrl;
    if (prevKey !== undefined) process.env.LITELLM_API_KEY = prevKey;
    if (prevMaster !== undefined) process.env.LITELLM_MASTER_KEY = prevMaster;
  }
});

test('an UNATTRIBUTED call is refused and not counted', async () => {
  const restore = withStubbedProxy(ok);
  try {
    const { dispatched } = await countLlmCalls(async () => {
      const res = await chat({ orgId: 'not-a-uuid' });
      assert.equal(res.error, 'not_configured');
    });
    assert.equal(dispatched, 0);
  } finally { restore(); }
});

test('a call that goes out and FAILS still counts — the request was sent', async () => {
  // A timeout or a 500 still consumed the call. Not counting it would let a
  // flapping proxy hide real spend.
  const restore = withStubbedProxy(() => new Response('nope', { status: 500 }));
  try {
    const { dispatched } = await countLlmCalls(async () => {
      const res = await chat();
      assert.equal(res.error, 'http_error');
    });
    assert.equal(dispatched, 1);
  } finally { restore(); }
});

test('a revision loop counts every call, not just the first', async () => {
  const restore = withStubbedProxy(ok);
  try {
    const { dispatched } = await countLlmCalls(async () => {
      await chat(); await chat(); await chat();
    });
    assert.equal(dispatched, 3, 'one critic call plus two rewrites is three calls');
  } finally { restore(); }
});

test('calls dispatched at any DEPTH are counted', async () => {
  // The reason this is measured at the gateway rather than threaded through
  // the critique/revision composition: nesting does not have to know.
  const restore = withStubbedProxy(ok);
  try {
    const deep = async () => { await chat(); };
    const middle = async () => { await deep(); await deep(); };
    const { dispatched } = await countLlmCalls(async () => { await middle(); });
    assert.equal(dispatched, 2);
  } finally { restore(); }
});

test('ISOLATION: concurrent tasks do not bleed into each other\'s tally', async () => {
  // Two conversations judged at once on the same worker. If the counter were a
  // module-level global, the quiet one would be billed for the busy one.
  const restore = withStubbedProxy(ok);
  try {
    const busy = countLlmCalls(async () => { await chat(); await chat(); await chat(); });
    const quiet = countLlmCalls(async () => { await chat(); });
    const [b, q] = await Promise.all([busy, quiet]);
    assert.equal(b.dispatched, 3);
    assert.equal(q.dispatched, 1, 'the quiet task is not charged for the busy one');
  } finally { restore(); }
});

test('a call outside any scope is safe and counted nowhere', async () => {
  const restore = withStubbedProxy(ok);
  try {
    const res = await chat();          // no countLlmCalls wrapper
    assert.equal(res.content, 'hi');   // must not throw
  } finally { restore(); }
});

// -- Timeout floor -----------------------------------------------------------
//
// A timeout shorter than the serving tier's latency is not a timeout.
//
// Measured 3 September 2026, twenty-token reply: the paid tier answers in 2s,
// the free tier in 28-38s. The free tier is the failover chain's zero-cost
// floor, so it serves whenever the paid tiers are exhausted or unfunded.
//
// Against it, the critic's 12-second budget does not fail fast - it fails
// ALWAYS. The critic never runs and the reply skips the gate it was supposed to
// pass, with every layer behaving exactly as written and nothing reporting it.

test('a budget below the floor is raised to it', () => {
  // The real call sites, as they were written for a fast paid model.
  for (const chosenForAFastModel of [12_000, 15_000, 30_000, 40_000]) {
    assert.strictEqual(
      effectiveTimeoutMs(chosenForAFastModel),
      60_000,
      `${chosenForAFastModel}ms is below the free tier's own measured latency`
    );
  }
});

test('a caller asking for more than the floor keeps it', () => {
  // The floor is a minimum, not a cap.
  assert.strictEqual(effectiveTimeoutMs(90_000), 90_000);
  assert.strictEqual(effectiveTimeoutMs(300_000), 300_000);
});

test('an unspecified budget still clears the floor', () => {
  assert.strictEqual(effectiveTimeoutMs(undefined), 60_000);
  assert.strictEqual(effectiveTimeoutMs(), 60_000);
});

test('zero and negative are treated as unspecified, never as instant', () => {
  // A caller passing 0 means "I did not choose", not "abort immediately".
  assert.strictEqual(effectiveTimeoutMs(0), 60_000);
  assert.strictEqual(effectiveTimeoutMs(-1), 60_000);
});
