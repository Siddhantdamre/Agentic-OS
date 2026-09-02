#!/usr/bin/env node
'use strict';
/**
 * A MESSAGE MUST REACH AN EMPLOYEE THAT CAN WORK THE CHANNEL IT ARRIVED ON.
 *
 * Inbound routing was `WHERE status = 'active' LIMIT 1` with no ORDER BY. Every
 * message went to whichever row Postgres returned first, so one employee per org
 * accumulated every action and the rest accumulated none — 8 of 9 employees in
 * the demo workspace had never acted, while their tool allowlists said they were
 * specialists in different things.
 *
 * Nothing failed. No test went red. The roster looked staffed, the permission
 * model was genuinely enforced, and the throughput of eight employees was zero.
 * That is the defect class this repo keeps meeting: complete, correct, and never
 * reached. It is only visible by asking whether the rows are distributed the way
 * the design claims.
 *
 * Checks the ORDER of the shipped SQL, then proves the ordering actually selects
 * the channel holder against real rows in a scratch org.
 *
 * Usage: node infra/scripts/check-inbound-routing.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'apps/dashboard/lib/channel-normalize.ts');

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(ROOT, 'apps/dashboard/node_modules/pg')).Client; }

require('./lib/env').loadRepoEnv();

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  INBOUND ROUTING — work reaches an employee that can do it          ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

// ── 1. The shipped query is not "whoever comes first" ───────────────────────
const src = fs.readFileSync(SRC, 'utf8');
const sel = src.match(/SELECT id, name, role, persona, tool_allowlist FROM ai_employees[\s\S]{0,600}?LIMIT 1/);

if (!sel) {
  no('the inbound employee query still exists');
} else {
  const q = sel[0];
  /ORDER BY/i.test(q)
    ? ok('the selection is ordered', 'not "whichever row the planner returns first"')
    : no('the selection is ordered', 'LIMIT 1 with no ORDER BY picks an arbitrary employee');

  /ANY\(tool_allowlist\)/.test(q)
    ? ok('it prefers an employee holding the channel tool', 'capability, not position')
    : no('it prefers an employee holding the channel tool');

  /created_at/.test(q)
    ? ok('ties break deterministically', 'same input selects the same employee on replay')
    : no('ties break deterministically', 'an unstable tiebreak makes routing unreproducible');
}

// ── 2. The ordering actually works against real rows ────────────────────────
(async () => {
  await db.connect();
  let orgId = null;
  try {
    orgId = (await db.query(`SELECT org_provision($1, $2) AS id`,
      ['Routing Probe', `routing-probe-${Date.now()}`])).rows[0].id;

    // Three employees: one holds WhatsApp, one holds more tools but not
    // WhatsApp, one holds nothing. Created oldest-first in that order so a
    // naive "first row" query would pick the WRONG one for a non-WhatsApp
    // channel and the RIGHT one by accident for WhatsApp — the probe below
    // therefore asks for gmail, where position and capability disagree.
    const mk = async (name, tools, ageMinutes) => (await db.query(
      `INSERT INTO ai_employees (org_id, name, role, status, tool_allowlist, created_at)
       VALUES ($1, $2, 'probe', 'active', $3, NOW() - ($4 || ' minutes')::interval)
       RETURNING id`,
      [orgId, name, tools, String(ageMinutes)])).rows[0].id;

    await mk('Oldest_NoTools', [], 30);          // would win a naive created_at sort
    await mk('Broad_NoGmail', ['whatsapp', 're', 'metrics'], 20);
    const gmailHolder = await mk('Gmail_Holder', ['gmail'], 10);  // newest, narrowest

    const pick = async (tool) => (await db.query(
      `SELECT id, name FROM ai_employees
        WHERE org_id = $1 AND status = 'active'
        ORDER BY ($2 = ANY(tool_allowlist)) DESC,
                 COALESCE(array_length(tool_allowlist, 1), 0) DESC,
                 created_at ASC
        LIMIT 1`, [orgId, tool])).rows[0];

    const forGmail = await pick('gmail');
    forGmail.id === gmailHolder
      ? ok('an email lands on the employee holding Gmail',
        `${forGmail.name}, though it is the newest and narrowest`)
      : no('an email lands on the employee holding Gmail', `got ${forGmail.name}`);

    const forWhatsapp = await pick('whatsapp');
    forWhatsapp.name === 'Broad_NoGmail'
      ? ok('a WhatsApp message lands on the WhatsApp holder', forWhatsapp.name)
      : no('a WhatsApp message lands on the WhatsApp holder', `got ${forWhatsapp.name}`);

    // No holder at all: must still return somebody rather than dropping the
    // message. Losing an inbound customer message is worse than routing it
    // imperfectly.
    const forUnknown = await pick('quickbooks');
    forUnknown
      ? ok('an unmatched channel still reaches someone', `${forUnknown.name} — never dropped`)
      : no('an unmatched channel still reaches someone', 'message would have no owner');

    // Stability: the same question twice must give the same answer.
    const a = await pick('gmail');
    const b = await pick('gmail');
    a.id === b.id
      ? ok('the same message routes to the same employee twice', 'reproducible')
      : no('the same message routes to the same employee twice');

  } finally {
    if (orgId) {
      await db.query('DELETE FROM ai_employees WHERE org_id = $1', [orgId]).catch(() => {});
      await db.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
    }
    await db.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
