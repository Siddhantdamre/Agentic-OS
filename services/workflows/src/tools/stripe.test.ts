import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripe } from './stripe.js';

const ORG = '00000000-0000-4000-8000-0000000000c6';
const TS = '2026-08-14T00:00:00.000Z';

function ctx(action: string, payload: Record<string, unknown> = {}) {
  return { tool: 'stripe', action, actionName: action, payload, orgId: ORG, timestamp: TS };
}

test('create_refund never fabricates success when Stripe is not connected', async () => {
  const result = await stripe.execute(ctx('create_refund', { chargeId: 'ch_test123' }));
  assert.equal(result.status, 'error');
  assert.equal((result.data as any)?.connected, false);
  assert.match(String(result.message || ''), /not connected/i);
});

test('create_refund is classified as the highest-risk (pay) tier', () => {
  assert.equal(stripe.risk('create_refund'), 'pay');
});
