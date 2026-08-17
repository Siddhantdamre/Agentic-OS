import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyChargeEvent, tenantClaimClosesCharge } from './charges.js';
import type { ChargeRecord } from './types.js';

const OPEN: ChargeRecord = {
  id: 'chg-1',
  orgId: 'org-a',
  status: 'open',
  amount: 50_000,
  currency: 'INR',
  pspPaymentId: null,
  closedReason: null,
  claimedPaidAt: null,
};

test('tenant I paid does not close a charge', () => {
  const next = applyChargeEvent(OPEN, { kind: 'tenant_claim' }, '2026-08-13T00:00:00.000Z');
  assert.equal(next.status, 'open');
  assert.equal(next.claimedPaidAt, '2026-08-13T00:00:00.000Z');
  assert.equal(tenantClaimClosesCharge(), false);
});

test('PSP webhook closes a charge', () => {
  const next = applyChargeEvent(OPEN, { kind: 'psp_webhook', pspPaymentId: 'pay_abc' }, '2026-08-13T00:00:00.000Z');
  assert.equal(next.status, 'closed');
  assert.equal(next.closedReason, 'psp_webhook');
  assert.equal(next.pspPaymentId, 'pay_abc');
});
