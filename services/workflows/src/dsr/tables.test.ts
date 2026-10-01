import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DSR_DELETE_TABLES,
  markTableDone,
  parseDsrDeleteProgress,
  remainingDeleteTables,
} from './tables.js';

describe('DSR delete progress resume', () => {
  it('parses empty progress as nothing done', () => {
    const p = parseDsrDeleteProgress({});
    assert.deepEqual(p.doneTables, []);
    assert.deepEqual(p.deleted, {});
    assert.equal(remainingDeleteTables(DSR_DELETE_TABLES, p).length, DSR_DELETE_TABLES.length);
  });

  it('skips already-done tables so a retry does not restart from zero', () => {
    let progress = parseDsrDeleteProgress({});
    const first = DSR_DELETE_TABLES[0]!;
    const second = DSR_DELETE_TABLES[1]!;
    progress = markTableDone(progress, first, 3);
    progress = markTableDone(progress, second, 0);

    const remaining = remainingDeleteTables(DSR_DELETE_TABLES, progress);
    assert.equal(remaining.includes(first), false);
    assert.equal(remaining.includes(second), false);
    assert.equal(remaining[0], DSR_DELETE_TABLES[2]);
    assert.equal(progress.deleted[first], 3);
  });

  it('never leaves a mid-job cursor without a resume set (doneTables grows)', () => {
    // Simulates: request dies after N tables → status may still say running,
    // but the next pass resumes from doneTables rather than staying stuck.
    let progress = parseDsrDeleteProgress({
      doneTables: DSR_DELETE_TABLES.slice(0, 5),
      deleted: Object.fromEntries(DSR_DELETE_TABLES.slice(0, 5).map((t) => [t, 1])),
      currentTable: DSR_DELETE_TABLES[5],
    });
    const remaining = remainingDeleteTables(DSR_DELETE_TABLES, progress);
    assert.equal(remaining.length, DSR_DELETE_TABLES.length - 5);
    assert.equal(remaining[0], DSR_DELETE_TABLES[5]);

    progress = markTableDone(progress, remaining[0]!, 2);
    const after = remainingDeleteTables(DSR_DELETE_TABLES, progress);
    assert.equal(after.includes(DSR_DELETE_TABLES[5]!), false);
    assert.equal(progress.doneTables.length, 6);
  });

  it('parseDsrDeleteProgress ignores malformed payloads', () => {
    const p = parseDsrDeleteProgress({ doneTables: [1, 'ok'], deleted: 'nope' });
    assert.deepEqual(p.doneTables, ['ok']);
    assert.deepEqual(p.deleted, {});
  });
});
