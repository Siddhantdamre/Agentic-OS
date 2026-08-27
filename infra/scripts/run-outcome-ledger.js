#!/usr/bin/env node
'use strict';
/**
 * RUN THE OUTCOME LEDGER — turn raw activity into "what did the AI actually do".
 *
 * WHY THIS EXISTS
 * Migrations 022 and 023 built agent_actions, outcome_events, action_outcomes
 * and the outcome_lift view. services/workflows/src/activities/outcome-ledger.ts
 * implements the materialisation and attribution, and outcomes/attribution.ts
 * has 18 passing unit tests behind it. `runOutcomeLedger` had ZERO importers.
 * The whole subsystem was correct, tested, and never once executed.
 *
 * That is the measurement that answers the only question a customer asks at
 * renewal: what did this do for us? Without it the answer is a feeling.
 *
 * WHY A SCRIPT RATHER THAN A TEMPORAL SCHEDULE
 * A Temporal schedule is the better long-term home and this should move there
 * once there is a registration step someone actually runs. Today there is no
 * cron infrastructure in this repo at all, and a scheduled workflow nobody
 * registers is exactly the failure this script exists to correct. A plain
 * script that joins the existing hourly alerting cadence can be run by hand,
 * read in one sitting, and cannot silently not-exist.
 *
 * WINDOWING
 * The window per org is [last materialised action, now), minus an overlap.
 * Derived from the data rather than tracked in a table: max(occurred_at) on
 * agent_actions IS the high-water mark, and every insert in the ledger is
 * ON CONFLICT DO NOTHING, so overlapping re-runs are free and late-arriving
 * rows are picked up rather than lost at a boundary. No new state to keep
 * correct, and nothing to repair if a run is missed.
 *
 * Usage:
 *   node infra/scripts/run-outcome-ledger.js              all active orgs
 *   node infra/scripts/run-outcome-ledger.js --org <uuid> one org
 *   node infra/scripts/run-outcome-ledger.js --days 30    force a wider window
 *   node infra/scripts/run-outcome-ledger.js --json       machine-readable
 *
 * Exit: 0 = ran (including "nothing to do"), 1 = could not run.
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const LEDGER = path.join(__dirname, '../../services/workflows/dist/activities/outcome-ledger.js');
let ledger;
try {
  ledger = require(LEDGER);
} catch (err) {
  console.error(`\n  Cannot load the ledger from ${LEDGER}`);
  console.error('  Build it first:  cd services/workflows && npx tsc -p tsconfig.json\n');
  console.error(`  ${err.message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const ORG_ARG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const DAYS_ARG = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : null;

/**
 * Re-scan this far behind the high-water mark on every run.
 *
 * An outcome can be attributed to an action up to the attribution window (24h
 * by default) after it. A run that started exactly at the high-water mark
 * would never revisit the actions just before it, so any outcome that arrived
 * late would be permanently unattributed — the ledger would under-report, and
 * it would under-report silently. Two days covers the attribution window with
 * room to spare, and costs nothing because every insert is idempotent.
 */
const OVERLAP_HOURS = 48;

/** How far back a first-ever run reaches. */
const COLD_START_DAYS = 30;

/**
 * How long a conversation must be silent before it counts as finished.
 *
 * 24h is deliberately generous. Closing too early turns "the customer is
 * asleep" into "the agent resolved it", and an inflated resolution rate is
 * worse than no resolution rate: it is a number a business will quote to
 * itself and then be wrong about.
 */
const QUIET_HOURS = Number(process.env.CONVERSATION_QUIET_HOURS || 24);

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

async function orgsToProcess() {
  if (ORG_ARG) return [{ id: ORG_ARG, name: '(named on the command line)' }];
  // Only orgs with actual conversation activity. Running the ledger over an
  // org that has never had a customer message is pure cost for a guaranteed
  // empty result, and on a deployment with 58 tenants that is most of them.
  const res = await db.query(`
    SELECT o.id, o.name
      FROM orgs o
     WHERE o.status = 'active'
       AND EXISTS (
         SELECT 1 FROM messages m
          WHERE m.org_id = o.id
            AND m.created_at > NOW() - ($1 || ' days')::interval
       )
     ORDER BY o.created_at`, [String(DAYS_ARG || COLD_START_DAYS)]);
  return res.rows;
}

async function windowFor(orgId) {
  const until = (await db.query('SELECT NOW() AS now')).rows[0].now;

  if (DAYS_ARG) {
    const since = new Date(until.getTime() - DAYS_ARG * 86400_000);
    return { since: since.toISOString(), until: until.toISOString(), reason: `forced ${DAYS_ARG}d` };
  }

  const hw = await db.query(
    `SELECT MAX(occurred_at) AS hw FROM agent_actions WHERE org_id = $1`, [orgId]);
  const mark = hw.rows[0]?.hw;

  if (!mark) {
    const since = new Date(until.getTime() - COLD_START_DAYS * 86400_000);
    return { since: since.toISOString(), until: until.toISOString(), reason: 'first run' };
  }
  const since = new Date(mark.getTime() - OVERLAP_HOURS * 3600_000);
  return { since: since.toISOString(), until: until.toISOString(), reason: 'incremental' };
}

(async () => {
  await db.connect();
  const orgs = await orgsToProcess();
  const results = [];

  if (!AS_JSON) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  OUTCOME LEDGER — what the agent did, and what followed      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    console.log(`  ${orgs.length} org(s) with recent activity\n`);
  }

  let failed = 0;
  let sweptAuto = 0;
  let sweptHuman = 0;
  for (const org of orgs) {
    const w = await windowFor(org.id);
    try {
      // Close quiet conversations BEFORE materialising, so this run's window
      // sees the resolutions it just created. The other order works too — the
      // next run would pick them up — but it means every reported resolution
      // is one cycle stale, and a number that lags its own cause is the kind
      // of thing nobody can debug six months later.
      const swept = await db.query(
        `SELECT * FROM close_quiet_conversations($1::uuid, $2::int)`,
        [org.id, QUIET_HOURS],
      );
      sweptAuto += Number(swept.rows[0]?.resolved_autonomous || 0);
      sweptHuman += Number(swept.rows[0]?.resolved_with_human || 0);

      const r = await ledger.runOutcomeLedger({
        orgId: org.id,
        since: w.since,
        until: w.until,
        // Holdout stays OFF unless an operator asks for it. A control group
        // means deliberately withholding the agent from a slice of real
        // customers, and that is a decision a business makes, never a default
        // a script turns on.
        holdoutPercent: 0,
        // Cross-conversation correlation stays off too: it is the difference
        // between "this reply was followed by a sale" and "something the agent
        // did somewhere was followed by a sale".
        allowWeak: false,
      });
      results.push({ orgId: org.id, name: org.name, window: w, ...r });
      if (!AS_JSON) {
        const s = r.summary || {};
        console.log(`  [ OK ]  ${String(org.name).slice(0, 34).padEnd(34)} `
          + `${String(r.actionsIngested).padStart(5)} actions  `
          + `${String(r.outcomesIngested).padStart(5)} outcomes  `
          + `${String(r.edgesWritten).padStart(5)} attributed   (${w.reason})`);
        if (s.attributedPct !== undefined) {
          console.log(`          ${s.attributedPct}% of actions produced a measurable outcome`);
        }
      }
    } catch (err) {
      failed++;
      results.push({ orgId: org.id, name: org.name, error: String(err.message || err) });
      if (!AS_JSON) {
        console.log(`  [FAIL]  ${String(org.name).slice(0, 34).padEnd(34)} ${String(err.message).slice(0, 60)}`);
      }
    }
  }

  await db.end();
  try { await ledger.closeOutcomeLedgerPool(); } catch { /* pool may be unused */ }

  if (AS_JSON) {
    console.log(JSON.stringify({ orgs: results.length, failed, results }, null, 2));
  } else {
    console.log(`\n  ${results.length - failed} of ${results.length} org(s) materialised`
      + `${failed ? `, ${failed} failed` : ''}.`);
    console.log(`  closed ${sweptAuto + sweptHuman} quiet conversation(s) — `
      + `${sweptAuto} handled autonomously, ${sweptHuman} needed a human.\n`);
  }
  process.exit(failed && failed === results.length ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
