import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveActionType } from '@darex/shared-types';
import { checkAutonomy, normalizeBlastRadius } from './autonomy.js';

test('read tools execute without a pending row', async () => {
  const v = await checkAutonomy({
    orgId: '00000000-0000-4000-8000-000000000001',
    employeeRole: 'operations',
    tool: 'hubspot',
    action: 'list_contacts',
    confidence: 0.9,
  });
  assert.equal(v.mode, 'execute');
  assert.equal(v.reasonCode, 'reversible_within_policy');
  assert.equal(v.bucket, 'read');
});

test('refund_payment always requires approval', async () => {
  const v = await checkAutonomy({
    orgId: '00000000-0000-4000-8000-000000000001',
    employeeRole: 'customer',
    tool: 'stripe',
    action: 'refund_payment',
    confidence: 0.99,
    blastRadius: { amount: 1 },
  });
  assert.equal(v.mode, 'approval_required');
  assert.equal(v.reasonCode, 'irreversible_action');
  assert.equal(v.bucket, 'irreversible');
});

test('unknown tools take the cautious external_send path', () => {
  const r = resolveActionType('mystery', 'do_the_thing');
  assert.equal(r.actionType, 'unknown');
  assert.equal(r.bucket, 'external_send');
});

test('unknown blast radius is 0.3 not zero', () => {
  assert.equal(normalizeBlastRadius(undefined), 0.3);
  assert.ok(normalizeBlastRadius({ amount: 200_000 }) > 0.9);
});

test('external send asks under default policy', async () => {
  const v = await checkAutonomy({
    orgId: '00000000-0000-4000-8000-000000000001',
    employeeRole: 'customer',
    tool: 'whatsapp',
    action: 'send_message',
    confidence: 0.95,
  });
  assert.equal(v.mode, 'approval_required');
  assert.equal(v.reasonCode, 'org_rule_requires_approval');
});

test('read-only tools whose names carry no read verb classify as read, destructive actions stay gated', async () => {
  const { resolveActionType } = await import('./autonomy.js');
  for (const [tool, action] of [['database_query', 'query'], ['db_query', 'query'], ['sql_analytics', 'query'], ['web_extract', 'extract']]) {
    assert.equal(resolveActionType(tool, action).bucket, 'read', `${tool}.${action}`);
  }
  assert.equal(resolveActionType('database_query', 'delete_rows').bucket, 'irreversible');
  assert.equal(resolveActionType('unknown_tool', 'run').bucket, 'external_send');
});
