import assert from 'node:assert/strict';
import test from 'node:test';
import { customerOps } from './customer-ops.js';

test('customer-ops list_open_loops is read-only (no confirm)', () => {
  assert.equal(customerOps.risk('list_open_loops'), 'read');
  assert.equal(customerOps.confirm('list_open_loops'), false);
});

test('customer-ops list_at_risk_conversations is read-only', () => {
  assert.equal(customerOps.risk('list_at_risk_conversations'), 'read');
  assert.equal(customerOps.confirm('list_at_risk_conversations'), false);
});

test('customer-ops rejects unknown actions without fabricating data', async () => {
  const result = await customerOps.execute({
    tool: 'customer-ops',
    action: 'invent_tickets',
    actionName: 'invent_tickets',
    payload: {},
    orgId: '00000000-0000-4000-8000-000000000001',
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.status, 'error');
  assert.equal(result.data, null);
});
