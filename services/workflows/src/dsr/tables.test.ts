import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  DSR_DELETE_TABLES,
  DSR_RETAINED_TABLES,
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

/** Every table the migrations give an org_id column (checked equal to the live schema). */
function orgScopedTables(): Set<string> {
  const dir = resolve(__dirname, '../../../../infra/db/migrations');
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_0-9]+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      if (/(^|[\s,(])org_id\s/i.test(m[2])) found.add(m[1].toLowerCase());
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?([a-z_0-9]+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?org_id\b/gi)) {
      found.add(m[1].toLowerCase());
    }
  }
  return found;
}

describe('DSR delete coverage (SEC-C01)', () => {
  const orgTables = orgScopedTables();

  it('classifies every org_id table as deleted or retained with a reason', () => {
    assert.ok(orgTables.size > 50, `parsed only ${orgTables.size} org tables; the migration parser broke`);
    const deleted = new Set(DSR_DELETE_TABLES);
    const unclassified = [...orgTables].filter((t) => !deleted.has(t) && !(t in DSR_RETAINED_TABLES)).sort();
    assert.deepEqual(unclassified, [], `add these to a DSR delete list or DSR_RETAINED_TABLES: ${unclassified.join(', ')}`);
  });

  it('never both deletes and retains a table, and lists no table twice', () => {
    assert.deepEqual(DSR_DELETE_TABLES.filter((t) => t in DSR_RETAINED_TABLES), []);
    assert.equal(new Set(DSR_DELETE_TABLES).size, DSR_DELETE_TABLES.length);
  });

  it('deletes the memory revision history and sync cursors (MEM-E01)', () => {
    assert.ok(DSR_DELETE_TABLES.includes('memory_revisions'));
    assert.ok(DSR_DELETE_TABLES.includes('sync_cursors'));
  });
});
