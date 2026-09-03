#!/usr/bin/env node
'use strict';
/**
 * THE MIGRATION LEDGER MUST MATCH THE MIGRATION FILES.
 *
 * `_migrations` is the record a deployment reads to decide what still needs
 * running. Nothing checked that it agreed with reality, and it did not:
 *
 *   45 files on disk, 43 rows in _migrations
 *
 * Migrations 044 and 045 were applied BY HAND during development. Both were
 * live and verified — `duty_run` was in the `action_kind` CHECK and the
 * `org_memory_market_needs_source` constraint existed — while the ledger said
 * neither had ever run.
 *
 * ── WHY THAT IS WORSE THAN IT SOUNDS ────────────────────────────────────────
 *
 * The two directions of drift fail in opposite ways and neither is visible:
 *
 *   applied, not recorded   a fresh deploy re-runs it. Safe only if the file
 *                           is idempotent, and nothing forces it to be.
 *   recorded, not applied   the deploy skips it forever. The column, index or
 *                           constraint simply never exists in production, and
 *                           the first symptom is a failing insert.
 *
 * Both are silent. The database looks correct on the machine where the work
 * was done, which is exactly the machine nobody deploys from.
 *
 * This asserts the ledger names every file, and — where the file is a CHECK
 * constraint — that the constraint is actually present, because a row in
 * `_migrations` proves only that the runner did not throw.
 *
 * Usage: node infra/scripts/check-migrations-applied.js
 * Exit:  0 = ledger and disk agree, 1 = they do not.
 */
const fs = require('fs');
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'infra', 'db', 'migrations');

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(ROOT, 'apps/dashboard/node_modules/pg')).Client; }

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

let pass = 0;
const failures = [];
const ok = (m, d) => { pass += 1; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d) => { failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

(async () => {
  console.log('\n=== MIGRATIONS — does the ledger match the files? ===\n');
  await db.connect();

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  files.length > 0
    ? ok(`${files.length} migration files on disk`)
    : no('migration files found', `none in ${DIR} — wrong path?`);

  const led = await db.query('SELECT filename FROM _migrations').catch(() => null);
  if (!led) {
    no('the _migrations ledger exists',
      'table missing — this database has never been migrated by infra/db/migrate.js');
    return report();
  }
  const applied = new Set(led.rows.map((r) => r.filename));
  ok(`${applied.size} rows in the ledger`);

  // ── Every file recorded ───────────────────────────────────────────────────
  const missing = files.filter((f) => !applied.has(f));
  missing.length === 0
    ? ok('every migration file is recorded as applied')
    : no('every migration file is recorded as applied',
      `${missing.join(', ')} — run \`node infra/db/migrate.js\`. If these were `
      + 'applied by hand, the ledger is lying to your next deploy.');

  // ── Nothing recorded that no longer exists ────────────────────────────────
  //
  // A row naming a deleted file means the deploy considers work done that
  // nobody can now review or re-run.
  const orphans = [...applied].filter((f) => !files.includes(f));
  orphans.length === 0
    ? ok('the ledger names no migration that is missing from disk')
    : no('the ledger names no migration that is missing from disk',
      `${orphans.join(', ')} — recorded as applied, but the file is gone`);

  // ── The constraints those migrations add are actually there ───────────────
  //
  // A ledger row proves the runner did not throw. It does not prove the
  // constraint survived — a later migration, or a hand-edit, can drop one and
  // the ledger will never notice. These two are checked by name because both
  // are load-bearing: one is why a typo'd action kind fails loudly instead of
  // creating a category nothing reads, the other is why a market fact cannot
  // exist without a source.
  const expect = [
    ['agent_actions_kind_chk', "duty_run", 'a duty run can be attributed in the ledger (044)'],
    ['org_memory_market_needs_source', null, 'a market fact must name its source (045)'],
  ];
  for (const [name, mustContain, why] of expect) {
    const r = await db.query(
      'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [name]);
    if (r.rows.length === 0) {
      no(why, `constraint ${name} is not present, whatever the ledger says`);
    } else if (mustContain && !String(r.rows[0].def).includes(mustContain)) {
      no(why, `constraint ${name} exists but does not mention "${mustContain}"`);
    } else {
      ok(why, name);
    }
  }

  report();
})().catch((err) => {
  console.log(`ERROR: ${err && err.message}`);
  process.exitCode = 1;
  db.end().catch(() => {});
});

function report() {
  console.log(`\n  passed ${pass} / ${pass + failures.length}\n`);
  db.end().catch(() => {});
  if (failures.length) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('  PASS — the ledger and the files agree, and the constraints are live.\n');
  process.exit(0);
}
