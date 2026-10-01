import assert from 'node:assert/strict';
import test from 'node:test';
import { readOnlySqlViolation } from './database.js';

test('read-only SQL allows a plain select', () => {
  assert.equal(readOnlySqlViolation('SELECT id FROM work_items LIMIT 5'), null);
});

test('read-only SQL rejects a CTE that deletes', () => {
  const sql = 'WITH d AS (DELETE FROM work_items RETURNING id) SELECT * FROM d';
  assert.match(readOnlySqlViolation(sql) || '', /read-only/i);
});

test('read-only SQL rejects set_config', () => {
  const sql = "SELECT set_config('app.current_org_id', '00000000-0000-4000-8000-000000000099', false)";
  assert.match(readOnlySqlViolation(sql) || '', /read-only/i);
});

test('read-only SQL ignores write keywords inside quotes', () => {
  assert.equal(readOnlySqlViolation("SELECT id FROM notes WHERE body = 'please delete this'"), null);
});

test('read-only SQL rejects a second statement', () => {
  assert.match(readOnlySqlViolation('SELECT 1; DELETE FROM work_items') || '', /single-statement/i);
});
