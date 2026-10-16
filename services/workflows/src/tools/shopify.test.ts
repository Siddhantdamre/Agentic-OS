import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shopify } from './shopify.js';

const ORG = '00000000-0000-4000-8000-0000000000c6';
const TS = '2026-08-14T00:00:00.000Z';

function ctx(action: string, payload: Record<string, unknown> = {}) {
  return { tool: 'shopify', action, actionName: action, payload, orgId: ORG, timestamp: TS };
}

test('update_order_address never fabricates success when Shopify is not connected', async () => {
  const result = await shopify.execute(
    ctx('update_order_address', { orderId: '123', shippingAddress: { address1: '1 Main St' } }),
  );
  assert.equal(result.status, 'error');
  assert.equal((result.data as any)?.connected, false);
  assert.match(String(result.message || ''), /not connected/i);
});

test('update_order_address is classified as a mutation (draft), fetches stay read-only', () => {
  assert.equal(shopify.risk('update_order_address'), 'draft');
  assert.equal(shopify.risk('fetch_orders'), 'read');
});
