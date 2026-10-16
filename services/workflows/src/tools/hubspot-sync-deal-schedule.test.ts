import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hubspot } from './hubspot.js';
import { roleCapabilityDenial } from './role-capability.js';

const ORG = '00000000-0000-4000-8000-0000000000c6';
const TS = '2026-08-14T00:00:00.000Z';

test('sync_deal_schedule never fabricates success when HubSpot is not connected', async () => {
  const result = await hubspot.execute({
    tool: 'hubspot',
    action: 'sync_deal_schedule',
    actionName: 'sync_deal_schedule',
    payload: { email: 'customer@example.com', note: 'Rescheduled to Friday 2pm' },
    orgId: ORG,
    timestamp: TS,
  });
  assert.equal(result.status, 'error');
  assert.match(String(result.message || ''), /not connected/i);
});

test('sync_deal_schedule is not blocked by the customer-persona update_deal/create_deal guardrail', () => {
  assert.equal(roleCapabilityDenial('customer', 'hubspot', 'sync_deal_schedule'), null);
  // The guardrail this deliberately avoids still blocks the real thing:
  assert.match(String(roleCapabilityDenial('customer', 'hubspot', 'update_deal')), /cannot update_deal/);
});
