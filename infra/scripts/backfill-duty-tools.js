#!/usr/bin/env node
'use strict';
/**
 * GRANT EXISTING EMPLOYEES THE TOOL THEIR OWN DUTY NEEDS.
 *
 * The pack manifests now give `database_query` to every role whose standing
 * duty is to read its own workspace, but a manifest only shapes employees
 * created after it changed. Employees already in the database keep the
 * allowlist they were installed with, so `planDuty` correctly reports Sarah,
 * Emma, Aisha and Meera as NOT PERMITTED to do their own jobs.
 *
 * This grants exactly one tool, only to employees whose role has a duty that
 * needs it, and only when they do not already hold it.
 *
 * WHY THIS IS A SMALL GRANT
 * database_query reads the tenant's own records: SELECT or WITH only, a single
 * statement, auto-limited, executed through an org-scoped client so row-level
 * security confines it to that tenant regardless of what SQL the model wrote.
 * And a duty runs with the minimum tool rather than the employee's allowlist,
 * so holding it does not widen what the employee may do inside a customer
 * conversation.
 *
 * Usage:
 *   node infra/scripts/backfill-duty-tools.js           # report only
 *   node infra/scripts/backfill-duty-tools.js --apply   # grant
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(ROOT, 'apps/dashboard/node_modules/pg')).Client; }

const { dutyForRole } = require(path.join(ROOT, 'services/workflows/dist/duties.js'));

const APPLY = process.argv.includes('--apply');

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const line = (s = '') => console.log(s);

(async () => {
  await db.connect();
  line('\n╔══════════════════════════════════════════════════════════════════════╗');
  line('║  BACKFILL — the tool each employee needs for its own duty            ║');
  line('╚══════════════════════════════════════════════════════════════════════╝\n');

  const rows = (await db.query(
    `SELECT e.id, e.name, e.role, e.tool_allowlist, o.name AS org
       FROM ai_employees e JOIN orgs o ON o.id = e.org_id
      WHERE e.status = 'active' ORDER BY o.name, e.name`
  )).rows;

  const needed = [];
  for (const r of rows) {
    const duty = dutyForRole(r.role);
    // Only ever grants database_query. A duty needing calendar or a payment
    // provider is a connection problem, never something to fix by widening an
    // allowlist — granting a tool the workspace cannot reach would turn an
    // honest "not connected" into a confusing "permitted but broken".
    if (!duty || duty.needs !== 'database_query') continue;
    const held = (r.tool_allowlist || []).map((t) => String(t).toLowerCase());
    if (held.includes('database_query')) continue;
    needed.push(r);
  }

  if (needed.length === 0) {
    line('  Every employee already holds the tool its duty needs.\n');
    await db.end().catch(() => {});
    return;
  }

  line(`  ${needed.length} employee(s) cannot perform their own duty:\n`);
  for (const r of needed) {
    line(`    ${String(r.org).slice(0, 26).padEnd(28)}${String(r.name).padEnd(11)}${r.role}`);
  }

  if (!APPLY) {
    line('\n  Report only. Pass --apply to grant database_query to these employees.\n');
    await db.end().catch(() => {});
    return;
  }

  let granted = 0;
  for (const r of needed) {
    // array_append, not a rewrite: never disturb tools already held.
    await db.query(
      `UPDATE ai_employees
          SET tool_allowlist = array_append(tool_allowlist, 'database_query'),
              updated_at = NOW()
        WHERE id = $1 AND NOT ('database_query' = ANY(tool_allowlist))`,
      [r.id]
    );
    granted += 1;
  }

  line(`\n  Granted database_query to ${granted} employee(s).\n`);
  await db.end().catch(() => {});
})().catch(async (e) => {
  line(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
