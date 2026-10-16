import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerIdempotencyKey } from './shared.js';

const base = {
  orgId: '00000000-0000-4000-8000-0000000000d1',
  tool: 'stripe',
  action: 'create_refund',
  payload: { chargeId: 'ch_1', amount: 500, reason: 'requested_by_customer' },
};

test('a retry of the same plan step gets the same provider key (RT-B10)', () => {
  const a = providerIdempotencyKey({ ...base, workflowId: 'plan-1' });
  const b = providerIdempotencyKey({
    ...base,
    workflowId: 'plan-1',
    // Same arguments in a different key order are the same call.
    payload: { reason: 'requested_by_customer', amount: 500, chargeId: 'ch_1' },
  });
  assert.ok(a);
  assert.match(a!, /^darex-[0-9a-f]{40}$/);
  assert.equal(a, b);
});

test('different arguments, actions, plans, approvals or orgs get different keys', () => {
  const a = providerIdempotencyKey({ ...base, workflowId: 'plan-1' });
  const variants = [
    providerIdempotencyKey({ ...base, workflowId: 'plan-1', payload: { ...base.payload, amount: 600 } }),
    providerIdempotencyKey({ ...base, workflowId: 'plan-1', action: 'create_charge' }),
    providerIdempotencyKey({ ...base, workflowId: 'plan-2' }),
    providerIdempotencyKey({ ...base, approvedPendingActionId: 'pa-1' }),
    providerIdempotencyKey({ ...base, workflowId: 'plan-1', orgId: '00000000-0000-4000-8000-0000000000d2' }),
  ];
  for (const v of variants) assert.notEqual(v, a);
  assert.equal(new Set(variants).size, variants.length);
});

test('no durable anchor means no key, so a chat call is never deduped by content alone', () => {
  assert.equal(providerIdempotencyKey(base), undefined);
});
