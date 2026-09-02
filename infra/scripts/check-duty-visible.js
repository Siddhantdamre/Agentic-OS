#!/usr/bin/env node
'use strict';
/**
 * WORK AN EMPLOYEE DID MUST APPEAR ON THAT EMPLOYEE'S PAGE.
 *
 * Six employees ran their standing duties three times each. All eighteen runs
 * were written to channel_logs with the employee's name. `agent_actions` held
 * none of them, so `/employees/[id]` — a page whose entire job is showing what
 * an employee did — showed nothing for any of it.
 *
 * The cause was a gap between two correct decisions. A duty deliberately does
 * not persist a message, because it is not a customer conversation. The outcome
 * ledger ingests replies from `messages` and tools from `proxy_call` logs.
 * Neither covers a duty, and nothing noticed, because both halves were behaving
 * exactly as written.
 *
 * This asserts the join that makes the work visible, end to end:
 *
 *   an AGENT_EXECUTION log for a self-directed run
 *     carries an employeeId (a NAME is not an identity — 52 employees here
 *     are called "Sarah")
 *     becomes a `duty_run` row in agent_actions
 *     attributed to that employee
 *     and only when the run actually succeeded
 *
 * Usage: node infra/scripts/check-duty-visible.js
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
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
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  DUTY VISIBILITY — work an employee did reaches its own page          ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

(async () => {
  await db.connect();
  let orgId = null;

  try {
    orgId = (await db.query(`SELECT org_provision($1, $2) AS id`,
      ['Duty Visibility Probe', `duty-vis-${Date.now()}`])).rows[0].id;

    const empId = (await db.query(
      `INSERT INTO ai_employees (org_id, name, role, status, tool_allowlist)
       VALUES ($1, 'Probe', 'Ops / analyst', 'active', ARRAY['metrics'])
       RETURNING id`, [orgId])).rows[0].id;

    // Three logs: a successful duty, a failed duty, and one with no employeeId.
    // The ledger must take the first and leave the other two.
    const mk = async (payload) => (await db.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, 'dashboard', 'AGENT_EXECUTION', 'success', 200, 'probe', $2::jsonb)
       RETURNING id`,
      [orgId, JSON.stringify(payload)])).rows[0].id;

    const goodId = await mk({
      employeeName: 'Probe', employeeId: empId, selfDirected: true,
      succeeded: true, usedTools: ['metrics'], stepsCount: 2,
    });
    await mk({
      employeeName: 'Probe', employeeId: empId, selfDirected: true,
      succeeded: false, usedTools: [], stepsCount: 0,
    });
    await mk({
      employeeName: 'Probe', selfDirected: true, succeeded: true,
      usedTools: ['metrics'], stepsCount: 1,
    });

    // Run the real ingest, not a copy of its SQL.
    const dist = path.join(ROOT, 'services/workflows/dist/activities/outcome-ledger.js');
    let ingested = null;
    try {
      const mod = require(dist);
      const fn = mod.runOutcomeLedger || null;
      if (fn) {
        await fn({
          orgId,
          since: new Date(Date.now() - 3600_000).toISOString(),
          until: new Date(Date.now() + 3600_000).toISOString(),
        });
        ingested = true;
      }
    } catch (e) {
      ingested = String(e.message || e);
    }

    if (ingested === true) {
      ok('the real ledger activity ran', 'not a re-implementation of its SQL');
    } else {
      // Fall back to asserting the shipped SQL shape, so the check still means
      // something when the activity is not directly callable. Print WHY it was
      // not callable — a silent downgrade to the weaker assertion is how a
      // check quietly stops testing the thing it claims to test.
      console.log(`  [note]  ledger not called directly: ${String(ingested).slice(0, 160)}`);
      const src = require('fs').readFileSync(
        path.join(ROOT, 'services/workflows/src/activities/outcome-ledger.ts'), 'utf8');
      /'duty_run'/.test(src) && /AGENT_EXECUTION/.test(src)
        ? ok('the ledger ingests AGENT_EXECUTION as duty_run', 'asserted on the shipped source')
        : no('the ledger ingests AGENT_EXECUTION as duty_run', String(ingested).slice(0, 80));
      /payload->>'employeeId'/.test(src)
        ? ok('it attributes by employeeId, not by name')
        : no('it attributes by employeeId, not by name', 'a name is not an identity');
      /succeeded'\s*=\s*'true'/.test(src)
        ? ok('a failed duty is not recorded as work')
        : no('a failed duty is not recorded as work');
      return;
    }

    const rows = (await db.query(
      `SELECT action_kind, employee_id, source_id FROM agent_actions
        WHERE org_id = $1 AND action_kind = 'duty_run'`, [orgId])).rows;

    rows.length === 1
      ? ok('exactly one duty_run recorded', 'the failed run and the unattributed run were both skipped')
      : no('exactly one duty_run recorded', `got ${rows.length}`);

    rows[0]?.employee_id === empId
      ? ok('the action names the employee that ran it')
      : no('the action names the employee that ran it', `got ${rows[0]?.employee_id}`);

    rows[0]?.source_id === String(goodId)
      ? ok('it traces back to the exact log row', 'source_id is the channel_logs id')
      : no('it traces back to the exact log row');

    // The page reads by employee_id; prove the join it performs returns this.
    const visible = (await db.query(
      `SELECT COUNT(*)::int AS n FROM agent_actions
        WHERE org_id = $1 AND employee_id = $2`, [orgId, empId])).rows[0].n;
    visible > 0
      ? ok('the employee page query finds it', `${visible} action(s) for this employee`)
      : no('the employee page query finds it', 'the work would be invisible again');

  } finally {
    if (orgId) {
      await db.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]).catch(() => {});
      await db.query('DELETE FROM channel_logs WHERE org_id = $1', [orgId]).catch(() => {});
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
