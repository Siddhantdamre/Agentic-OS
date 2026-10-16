import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeReconciliationDiff } from './reconciliation.js';

test('reconciliation diff identifies missing CRM records, duplicates, and stale records', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');
  const enquiries = [
    {
      id: 'enq-1',
      externalSenderId: 'arjun@acme.com',
      channel: 'website',
      state: 'new',
      createdAt: '2026-09-19T10:00:00.000Z',
    },
    {
      id: 'enq-2',
      externalSenderId: 'priya@globex.com',
      channel: 'whatsapp',
      state: 'new',
      createdAt: '2026-09-01T10:00:00.000Z', // 19 days old -> stale
    },
    {
      id: 'enq-3',
      externalSenderId: 'unknown@external.com',
      channel: 'email',
      state: 'new',
      createdAt: '2026-09-20T08:00:00.000Z', // not in CRM -> missing
    },
  ];

  const crmEntities = [
    {
      id: 'crm-1',
      identifier: 'arjun@acme.com',
      entityType: 'lead',
      createdAt: '2026-09-19T11:00:00.000Z',
    },
    {
      id: 'crm-2',
      identifier: 'priya@globex.com',
      entityType: 'customer',
      createdAt: '2026-09-01T08:00:00.000Z',
    },
    {
      id: 'crm-3',
      identifier: 'priya@globex.com', // Duplicate in CRM!
      entityType: 'contact',
      createdAt: '2026-09-05T08:00:00.000Z',
    },
  ];

  const diff = computeReconciliationDiff({
    enquiries,
    crmEntities,
    staleDaysThreshold: 7,
    now,
  });

  assert.equal(diff.missingCount, 1);
  assert.equal(diff.duplicateCount, 1);
  assert.equal(diff.staleCount, 1);
  assert.equal(diff.discrepancies.length, 3);

  const missing = diff.discrepancies.find((d) => d.kind === 'missing_crm_record');
  assert.ok(missing);
  assert.equal(missing.externalSenderId, 'unknown@external.com');

  const dup = diff.discrepancies.find((d) => d.kind === 'duplicate_record');
  assert.ok(dup);
  assert.match(dup.detail, /priya@globex\.com/);

  const stale = diff.discrepancies.find((d) => d.kind === 'stale_record');
  assert.ok(stale);
  assert.equal(stale.id, 'enq-2');
});

test('clean matched records produce zero discrepancies', () => {
  const diff = computeReconciliationDiff({
    enquiries: [
      { id: 'e1', externalSenderId: 'john@example.com', channel: 'web', state: 'closed', createdAt: '2026-09-20' },
    ],
    crmEntities: [
      { id: 'c1', identifier: 'john@example.com', createdAt: '2026-09-18' },
    ],
  });
  assert.equal(diff.discrepancies.length, 0);
  assert.equal(diff.missingCount, 0);
});
