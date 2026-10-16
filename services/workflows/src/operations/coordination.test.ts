import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contestsLease, EMPLOYEE_PRECEDENCE, OUTBOUND_DAILY_CAP, pickLeastLoadedRep } from './coordination.js';

test('customer outranks operations and growth', () => {
  assert.ok(EMPLOYEE_PRECEDENCE.customer > EMPLOYEE_PRECEDENCE.operations);
  assert.ok(EMPLOYEE_PRECEDENCE.operations > EMPLOYEE_PRECEDENCE.growth);
  assert.equal(contestsLease('growth', 'customer'), true);
  assert.equal(contestsLease('customer', 'growth'), false);
  assert.equal(OUTBOUND_DAILY_CAP, 1);
});

test('workload balancer picks the rep with fewest active leads', () => {
  const rep = pickLeastLoadedRep([
    { repId: 'a', activeCount: 5 },
    { repId: 'b', activeCount: 2 },
    { repId: 'c', activeCount: 8 },
  ]);
  assert.equal(rep, 'b');
});

test('workload balancer breaks a tie by least-recently-assigned rep', () => {
  const rep = pickLeastLoadedRep([
    { repId: 'a', activeCount: 2, lastAssignedAt: '2026-09-20T10:00:00Z' },
    { repId: 'b', activeCount: 2, lastAssignedAt: '2026-09-18T10:00:00Z' },
  ]);
  assert.equal(rep, 'b');
});

test('workload balancer returns null when no reps are available', () => {
  assert.equal(pickLeastLoadedRep([]), null);
});
