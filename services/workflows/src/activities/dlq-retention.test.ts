import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dlqRetentionDays } from './dlq-retention.js';

test('dlqRetentionDays defaults to 30 and ignores junk', () => {
  assert.equal(dlqRetentionDays(undefined), 30);
  assert.equal(dlqRetentionDays(''), 30);
  assert.equal(dlqRetentionDays('abc'), 30);
  assert.equal(dlqRetentionDays('0'), 30);
  assert.equal(dlqRetentionDays('-5'), 30);
});

test('dlqRetentionDays honours a valid override, floored', () => {
  assert.equal(dlqRetentionDays('7'), 7);
  assert.equal(dlqRetentionDays('14.9'), 14);
});
