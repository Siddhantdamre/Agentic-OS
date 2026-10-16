import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferDueTime } from './due-time.js';
test('default is 24 hours', () => {
  assert.equal(inferDueTime('thanks', new Date('2026-09-20T10:00:00Z')).basis, 'default');
});
test('explicit ISO', () => {
  assert.equal(inferDueTime('2026-09-22T16:00:00Z', new Date('2026-09-20T10:00:00Z')).basis, 'explicit');
});
