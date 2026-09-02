#!/usr/bin/env node
'use strict';
/**
 * THE MARKET EVERY EMPLOYEE IS WORKING IN.
 *
 * An agent reading only internal rows can tell you a lead went quiet. It cannot
 * tell you the lead went quiet in the month stamp duty changed, and that second
 * half is the difference between a report and intelligence.
 *
 * Market facts live in org_memory under kind='market'. Reusing that table
 * rather than adding one means they inherit row-level security, erasure, and
 * the retrieval path already built around it — a separate table would have to
 * re-earn all three.
 *
 * ── EVERY FACT CARRIES ITS SOURCE, AND THE SOURCE IS NOT OPTIONAL ─────────
 * A fact with no source is refused at write time. An employee answering a
 * customer with "rates rose 3.9%" needs to know whether that came from the
 * government registry or somebody's guess, because it changes how much weight
 * the claim can carry — and the agent is instructed to cite the source in the
 * same sentence it uses the fact.
 *
 * Usage:
 *   node infra/scripts/market-context.js --org <uuid>
 *   node infra/scripts/market-context.js --org <uuid> --add "<fact>" --source "<url or operator>"
 *   node infra/scripts/market-context.js --org <uuid> --clear
 */
const crypto = require('crypto');
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(ROOT, 'apps/dashboard/node_modules/pg')).Client; }

const args = process.argv.slice(2);
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const ORG = val('--org');
const ADD = val('--add');
const SOURCE = val('--source');
const CLEAR = args.includes('--clear');

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const line = (s = '') => console.log(s);

(async () => {
  if (!ORG) {
    line('\n  --org <uuid> is required.\n');
    process.exit(1);
  }

  await db.connect();
  try {
    if (CLEAR) {
      const r = await db.query(
        `DELETE FROM org_memory WHERE org_id = $1 AND kind = 'market'`, [ORG]);
      line(`\n  Removed ${r.rowCount} market fact(s).\n`);
      return;
    }

    if (ADD) {
      if (!SOURCE || !SOURCE.trim()) {
        // Refused at write time, not filtered at read time. A fact that reached
        // the store without provenance would be one bad query away from being
        // shown to an agent as though it had some.
        line('\n  REFUSED: --source is required. A market fact without a source is a rumour.\n');
        process.exit(1);
      }
      const hash = crypto.createHash('sha256').update(`${ADD}|${SOURCE}`).digest('hex');
      const res = await db.query(
        `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash, priority)
         VALUES ($1, 'market', $2, $3, 'market', $4, $5, 80)
         ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING
         RETURNING id`,
        [ORG, String(ADD).slice(0, 120), ADD, SOURCE, hash]
      );
      line(res.rowCount
        ? `\n  Recorded. Every employee will carry this, citing ${SOURCE}.\n`
        : '\n  Already known — nothing changed.\n');
      return;
    }

    const rows = (await db.query(
      `SELECT body, source_ref, created_at FROM org_memory
        WHERE org_id = $1 AND kind = 'market'
        ORDER BY created_at DESC LIMIT 20`, [ORG])).rows;

    line('\n╔══════════════════════════════════════════════════════════════════════╗');
    line('║  MARKET CONTEXT — what every employee carries into its duty          ║');
    line('╚══════════════════════════════════════════════════════════════════════╝\n');

    if (rows.length === 0) {
      line('  No market facts recorded. Employees work from internal data only,');
      line('  and will not speculate about the market — which is correct, and');
      line('  also less useful than it could be.\n');
      line('  Add one:');
      line('    node infra/scripts/market-context.js --org <uuid> \\');
      line('      --add "Thane ready-reckoner rates rose 3.9% for 2026" \\');
      line('      --source "igrmaharashtra.gov.in"\n');
      return;
    }

    for (const r of rows) {
      line(`  ${String(r.body).slice(0, 76)}`);
      line(`     source: ${r.source_ref}   recorded ${new Date(r.created_at).toISOString().slice(0, 10)}\n`);
    }
    line(`  ${rows.length} fact(s). Each is shown to every employee with its source,`);
    line('  and each is cited in any answer that relies on it.\n');
  } finally {
    await db.end().catch(() => {});
  }
})().catch(async (e) => {
  line(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
