import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityHealthInterceptor, orgIdFromArgs, safeErrorText, type HealthRecord } from './activity-health.js';

const ORG = '11111111-2222-4333-8444-555555555555';

const make = (now: { t: number }) => {
  const seen: HealthRecord[] = [];
  const factory = activityHealthInterceptor((r) => { seen.push(r); }, () => now.t);
  const ctx = { info: { activityType: 'openLoopSweepActivity' } } as any;
  return { seen, inbound: factory(ctx) };
};

test('finds the workspace in the first argument, as a string or as an object', () => {
  assert.equal(orgIdFromArgs([ORG]), ORG);
  assert.equal(orgIdFromArgs([{ orgId: ORG, other: 1 }]), ORG);
  assert.equal(orgIdFromArgs([{ org_id: ORG }]), ORG);
  assert.equal(orgIdFromArgs([{ orgId: 'not-a-uuid' }]), null);
  assert.equal(orgIdFromArgs([]), null);
  assert.equal(orgIdFromArgs([42]), null);
});

test('error text keeps the kind and the sentence, and drops emails and long numbers', () => {
  const t = safeErrorText(Object.assign(new Error('failed for priya@example.test phone 919800000001 at /x'), { name: 'SendError' }));
  assert.match(t, /^SendError: failed for/);
  assert.doesNotMatch(t, /priya@example\.test/);
  assert.doesNotMatch(t, /919800000001/);
  assert.ok(safeErrorText(new Error('x'.repeat(1000))).length <= 200);
});

test('a finished activity is recorded as ok, with the name and workspace', async () => {
  const now = { t: 1_000_000 };
  const { seen, inbound } = make(now);
  const out = await inbound.execute({ args: [{ orgId: ORG }], headers: {} } as any, async () => 'result' as any);
  assert.equal(out, 'result');
  assert.deepEqual(seen, [{ orgId: ORG, activity: 'openLoopSweepActivity', ok: true, error: null }]);
});

test('a failing activity is recorded and the original error still reaches Temporal unchanged', async () => {
  const now = { t: 1_000_000 };
  const { seen, inbound } = make(now);
  const boom = new Error('connection refused');
  await assert.rejects(() => inbound.execute({ args: [ORG], headers: {} } as any, async () => { throw boom; }), (e) => e === boom);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, false);
  assert.match(seen[0].error!, /connection refused/);
});

test('repeated successes are written at most once a minute, but every kind of failure is written', async () => {
  const now = { t: 1_000_000 };
  const { seen, inbound } = make(now);
  const run = () => inbound.execute({ args: [ORG], headers: {} } as any, async () => 1 as any);
  await run(); await run(); await run();
  assert.equal(seen.length, 1);
  now.t += 61_000;
  await run();
  assert.equal(seen.length, 2);
  const fail = () => inbound.execute({ args: [ORG], headers: {} } as any, async () => { throw new Error('a'); }).catch(() => undefined);
  await fail();
  now.t += 6_000;
  await fail();
  assert.equal(seen.filter((r) => !r.ok).length, 2);
});

test('an activity with no workspace is not recorded, and a broken recorder never breaks the activity', async () => {
  const now = { t: 1 };
  const factory = activityHealthInterceptor(() => { throw new Error('db down'); }, () => now.t);
  const inbound = factory({ info: { activityType: 'x' } } as any);
  assert.equal(await inbound.execute({ args: [{}], headers: {} } as any, async () => 'fine' as any), 'fine');
  assert.equal(await inbound.execute({ args: [ORG], headers: {} } as any, async () => 'fine' as any), 'fine');
});
