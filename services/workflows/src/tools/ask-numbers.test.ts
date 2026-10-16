import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askNumbers, defaultPeriod } from './ask-numbers.js';
import { researchTopic, gatewayLlm } from './research-topic.js';
import { improvementNote } from './improvement-note.js';

const ctx = (payload: Record<string, unknown>) =>
  ({ tool: 'x', action: 'read', actionName: 'read', payload, orgId: '11111111-2222-4333-8444-555555555555', timestamp: new Date().toISOString() }) as any;

test('the three tools are read-only and never ask for confirmation', () => {
  for (const t of [askNumbers, researchTopic, improvementNote]) {
    for (const a of t.actions) {
      assert.equal(t.risk(a), 'read');
      assert.equal(t.confirm(a), false);
    }
  }
});

test('a question that maps to no metric is declined without touching the database', async () => {
  const r = await askNumbers.execute(ctx({ question: 'what is the meaning of life' }));
  assert.equal(r.status, 'executed');
  assert.match(String(r.message), /can't compute that yet/i);
  assert.equal((r.data as any).computed, false);
});

test('a question mixing topics is declined, not guessed', async () => {
  const r = await askNumbers.execute(ctx({ question: 'overdue dues and new inquiries' }));
  assert.match(String(r.message), /can't compute that yet/i);
});

test('the default period is the last 30 UTC calendar days', () => {
  assert.deepEqual(defaultPeriod(new Date('2026-10-16T10:00:00Z')), { asOf: '2026-10-16', from: '2026-09-16', to: '2026-10-16' });
});

test('research without a model gateway says so and researches nothing', async () => {
  const saved = { b: process.env.LITELLM_BASE_URL, k: process.env.LITELLM_API_KEY, m: process.env.LITELLM_MASTER_KEY };
  delete process.env.LITELLM_BASE_URL; delete process.env.LITELLM_API_KEY; delete process.env.LITELLM_MASTER_KEY;
  try {
    assert.equal(gatewayLlm({}), null);
    const r = await researchTopic.execute(ctx({ topic: 'GST rate on commercial rent' }));
    assert.equal(r.status, 'error');
    assert.match(String(r.message), /Nothing was researched/);
  } finally {
    if (saved.b) process.env.LITELLM_BASE_URL = saved.b;
    if (saved.k) process.env.LITELLM_API_KEY = saved.k;
    if (saved.m) process.env.LITELLM_MASTER_KEY = saved.m;
  }
});

test('research with an empty topic asks for one', async () => {
  const r = await researchTopic.execute(ctx({ topic: '  ' }));
  assert.equal(r.status, 'error');
});
