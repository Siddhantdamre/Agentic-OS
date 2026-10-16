import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWorkerTraceBatch, workerLangfuseConfig } from './langfuse-trace.js';

const ORG = '00000000-0000-4000-8000-0000000000e1';

test('worker trace batch: org as user, event-level timestamp, generation with usage and cost (OPS-B03)', () => {
  const now = new Date('2026-10-05T10:00:00.000Z');
  const batch = buildWorkerTraceBatch(
    {
      name: 'AgentTurn-Worker',
      orgId: ORG,
      input: 'where is my order',
      output: 'It ships today.',
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, totalCostInUsd: 0.0012, durationMs: 2000 },
    },
    now
  ) as Array<{ type: string; timestamp: string; body: Record<string, any> }>;
  assert.deepEqual(batch.map((e) => e.type), ['trace-create', 'generation-create']);
  const [trace, gen] = batch;
  assert.equal(trace.timestamp, now.toISOString());
  assert.equal(trace.body.timestamp, undefined);
  assert.equal(trace.body.userId, ORG);
  assert.ok(trace.body.tags.includes('worker'));
  assert.equal(gen.body.traceId, trace.body.id);
  assert.deepEqual(gen.body.usage, { input: 120, output: 30, total: 150, unit: 'TOKENS' });
  assert.deepEqual(gen.body.costDetails, { total: 0.0012 });
  assert.equal(gen.body.startTime, '2026-10-05T09:59:58.000Z');
});

test('no usage and no model: trace only', () => {
  const batch = buildWorkerTraceBatch({ name: 'x', orgId: ORG, input: 'a', output: 'b' });
  assert.equal(batch.length, 1);
});

test('config needs host and both keys', () => {
  assert.equal(workerLangfuseConfig({ LANGFUSE_HOST: 'http://lf:3000' }), null);
  assert.deepEqual(
    workerLangfuseConfig({ LANGFUSE_HOST: 'http://lf:3000/', LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }),
    { host: 'http://lf:3000', publicKey: 'pk', secretKey: 'sk' }
  );
});
