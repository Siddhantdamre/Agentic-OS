#!/usr/bin/env node
'use strict';
/**
 * GIVE THE ROLES REAL HANDS.
 *
 * Measured before this existed: 56 AI employees, 51 "support" and 5 "sales",
 * and every one of them carried the identical tool_allowlist —
 * `{database_query}`, a read. The roles differed in persona text and in
 * nothing else, so "sales" and "support" were the same employee wearing
 * different name badges.
 *
 * This applies the per-role defaults from services/workflows/src/tools/
 * capability.ts, which is the single source: the list is NOT duplicated in SQL
 * or here, because two copies of an authorization table drift and the drift is
 * silent until somebody has a capability nobody granted them.
 *
 * ── PREVIEW BY DEFAULT ────────────────────────────────────────────────────
 * Widening what an AI employee may do to the world is not something to do as a
 * side effect of running a script. Without --write it prints the diff and
 * changes nothing.
 *
 * ── IT NEVER TAKES A CAPABILITY AWAY SILENTLY ─────────────────────────────
 * An owner may have granted something deliberately — razorpay to one
 * collections employee, say. Narrowing that without being asked would break a
 * working configuration to satisfy a default. So this only ever ADDS the role
 * baseline, reports anything held beyond it, and removes nothing unless
 * --strict is passed.
 *
 * Usage:
 *   node infra/scripts/apply-role-hands.js              preview every workspace
 *   node infra/scripts/apply-role-hands.js --org <id>   one workspace
 *   node infra/scripts/apply-role-hands.js --write      apply
 *   node infra/scripts/apply-role-hands.js --write --strict   also remove extras
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const { ROLE_HANDS, normalizeToolKey, riskOf } =
  require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'tools', 'capability.js'));

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const STRICT = args.includes('--strict');
const ORG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const asList = (v) => {
  if (Array.isArray(v)) return v.map(String);
  try { const p = JSON.parse(String(v || '[]')); return Array.isArray(p) ? p.map(String) : []; }
  catch { return []; }
};

(async () => {
  await db.connect();
  try {
    const rows = (await db.query(
      `SELECT id::text, org_id::text, name, role, tool_allowlist
         FROM ai_employees
        WHERE status = 'active' ${ORG ? 'AND org_id = $1' : ''}
        ORDER BY org_id, role`,
      ORG ? [ORG] : [])).rows;

    console.log(`\n=== ROLE HANDS === ${rows.length} active employee(s)`
      + `${WRITE ? '  [WRITING]' : '  [preview — nothing will change]'}\n`);

    let changed = 0;
    let unknownRole = 0;
    const beyond = [];

    for (const r of rows) {
      const role = String(r.role || '').toLowerCase();
      const baseline = ROLE_HANDS[role];
      if (!baseline) {
        unknownRole++;
        console.log(`  ${r.name} (${r.role || 'no role'}) — no baseline for this role, left alone`);
        continue;
      }

      const current = asList(r.tool_allowlist).map(normalizeToolKey);
      const wanted = baseline.map(normalizeToolKey);
      const missing = wanted.filter((t) => !current.includes(t));
      const extra = current.filter((t) => !wanted.includes(t));

      // Anything held beyond the baseline is reported with its risk, because
      // an extra 'read' is noise and an extra 'pay' is the whole point of
      // looking.
      for (const e of extra) {
        const risk = riskOf(e);
        if (risk !== 'read') beyond.push({ name: r.name, role, tool: e, risk });
      }

      if (!missing.length && !(STRICT && extra.length)) continue;
      changed++;

      const next = STRICT ? wanted : Array.from(new Set([...current, ...wanted]));
      console.log(`  ${r.name} (${role})`);
      if (missing.length) console.log(`      + ${missing.join(', ')}`);
      if (STRICT && extra.length) console.log(`      - ${extra.join(', ')}`);

      if (WRITE) {
        await db.query(
          `UPDATE ai_employees SET tool_allowlist = $1::text[], updated_at = NOW()
            WHERE id = $2 AND org_id = $3`,
          [next, r.id, r.org_id]);
      }
    }

    if (beyond.length) {
      console.log('\n  HELD BEYOND THE BASELINE — granted by a person, left in place:');
      for (const b of beyond) {
        console.log(`    ${b.name} (${b.role}) has ${b.tool}  [${b.risk}]`);
      }
      if (!STRICT) console.log('    Pass --strict to remove these. Read them first.');
    }

    console.log(`\n  ${changed} employee(s) ${WRITE ? 'updated' : 'would change'}`
      + `${unknownRole ? `, ${unknownRole} with no baseline role` : ''}.`);
    if (!WRITE && changed) console.log('  Re-run with --write to apply.\n');
    else console.log('');
  } finally {
    await db.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`\n  ERROR: ${e.message}\n`);
  process.exit(1);
});
