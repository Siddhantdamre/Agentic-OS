import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROI_METRIC_TYPES } from './activities/guarded-send.js';
import { canPreemptLease, leasePrecedence } from './autonomy.js';
import {
  growthWatchWorkflowId,
  morningCheckWorkflowId,
  openLoopsWorkflowId,
  stuckWorkWorkflowId,
} from './periodic-registry.js';

test('lease precedence is customer > operations > growth', () => {
  assert.ok(leasePrecedence('customer') > leasePrecedence('operations'));
  assert.ok(leasePrecedence('operations') > leasePrecedence('growth'));
  assert.equal(canPreemptLease('growth', 'customer'), true);
  assert.equal(canPreemptLease('customer', 'operations'), false);
});

test('ROI metric types match the 024 CHECK — recovery is churn_prevented', () => {
  assert.ok(ROI_METRIC_TYPES.includes('churn_prevented'));
  assert.equal((ROI_METRIC_TYPES as readonly string[]).includes('customer_recovered'), false);
});

test('periodic singleton ids match 16 §5', () => {
  assert.equal(openLoopsWorkflowId('org-1'), 'open-loops:org-1');
  assert.equal(morningCheckWorkflowId('org-1'), 'morning-check:org-1');
  assert.equal(stuckWorkWorkflowId('org-1'), 'stuck-work:org-1');
  assert.equal(growthWatchWorkflowId('org-1'), 'growth-watch:org-1');
});
