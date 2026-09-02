#!/usr/bin/env node
'use strict';
/**
 * START THE WORK THAT IS SUPPOSED TO HAPPEN WITHOUT BEING ASKED.
 *
 * Nothing in this system runs on a timer. There is no cron, no Temporal
 * Schedule, and the only setInterval calls are an SSE keepalive and a widget
 * embed. `insight-engine` — which dispatches StaleChase, Nurture and the owner
 * briefing — fires only when a human loads /analytics, /insight or Ask AI.
 *
 * So an "autonomous workforce" did nothing at all unless somebody opened a page,
 * and the owner briefing had produced exactly zero rows in its entire history.
 *
 * The workflows themselves do not need a scheduler. OwnerBriefingWorkflow ends
 * each run by sleeping until the next scheduled hour and calling continueAsNew,
 * which is a durable cron that survives worker restarts and keeps its history
 * bounded. MarketResearchWorkflow does the same with repeatEveryHours. They
 * were only ever missing a first start.
 *
 * That is what this does, once per org, with a deterministic workflow id so
 * running it twice is a no-op rather than a second daily briefing.
 *
 * Usage:
 *   node infra/scripts/start-recurring-work.js            # report only
 *   node infra/scripts/start-recurring-work.js --start    # actually start
 *   node infra/scripts/start-recurring-work.js --start --hour 8 --tz Asia/Kolkata
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(ROOT, 'apps/dashboard/node_modules/pg')).Client; }

/**
 * 127.0.0.1, never 'localhost' — the same trap check-e2e-inbound.js documents.
 *
 * Node resolves localhost to IPv6 ::1 first. Docker publishes on [::] too, but
 * that path resets the connection, so the Temporal client times out after 5s
 * against a cluster that is healthy and listening. It reads as "Temporal is
 * down" and is nothing of the sort.
 *
 * Only defaulted, never overridden: inside a container TEMPORAL_ADDRESS is set
 * to the compose service name and must win.
 */
if (!process.env.TEMPORAL_ADDRESS) {
  process.env.TEMPORAL_ADDRESS = '127.0.0.1:7233';
}

const args = process.argv.slice(2);
const DO_START = args.includes('--start');
const HOUR = args.includes('--hour') ? parseInt(args[args.indexOf('--hour') + 1], 10) : 8;
const TZ = args.includes('--tz') ? args[args.indexOf('--tz') + 1] : 'Asia/Kolkata';

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const line = (s = '') => console.log(s);

(async () => {
  line('\n╔══════════════════════════════════════════════════════════════════════╗');
  line('║  RECURRING WORK — what runs without anyone opening a page            ║');
  line('╚══════════════════════════════════════════════════════════════════════╝\n');

  await db.connect();

  /**
   * Orgs worth briefing every morning.
   *
   * Not "has an employee". Test suites provision a workspace per run and leave
   * it behind — there are 52 orgs all named "Bright Leaf Interiors", one
   * employee each, and starting 52 daily briefing loops for them would be
   * 52 permanent Temporal workflows producing noise nobody reads.
   *
   * A real workspace has a workforce AND traffic: more than one active employee
   * and at least one conversation. That is a deliberately conservative filter —
   * it skips a genuine new customer until their first conversation arrives,
   * which is the right way round. Starting a briefing loop is easy; noticing
   * fifty stray ones later is not.
   */
  const orgs = (await db.query(
    `SELECT o.id, o.name, COUNT(DISTINCT e.id)::int AS employees
       FROM orgs o
       JOIN ai_employees e ON e.org_id = o.id AND e.status = 'active'
      WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.org_id = o.id)
      GROUP BY o.id, o.name
     HAVING COUNT(DISTINCT e.id) > 1
      ORDER BY COUNT(DISTINCT e.id) DESC`
  )).rows;

  const briefed = (await db.query(
    `SELECT org_id, COUNT(*)::int AS n, MAX(created_at) AS latest
       FROM channel_logs WHERE event_type = 'OWNER_BRIEFING' GROUP BY org_id`
  )).rows;
  const briefMap = new Map(briefed.map((r) => [r.org_id, r]));

  line(`  ${orgs.length} workspace(s) with a real workforce and traffic\n`);
  line(`  ${'WORKSPACE'.padEnd(34)}${'STAFF'.padEnd(7)}BRIEFINGS EVER`);
  for (const o of orgs) {
    const b = briefMap.get(o.id);
    line(`  ${String(o.name).slice(0, 32).padEnd(34)}${String(o.employees).padEnd(7)}${b ? b.n : 0}`);
  }

  await db.end().catch(() => {});

  if (!DO_START) {
    line('\n  Report only. Pass --start to begin the daily briefing for each workspace.\n');
    return;
  }

  // Temporal client comes from the built workflows package so the connection
  // options, namespace and TLS settings are the worker's, not a second copy.
  const { getTemporalClient } = require(path.join(ROOT, 'services/workflows/dist/workflow-client.js'));
  const client = await getTemporalClient();
  if (!client) {
    line('\n  Temporal is unreachable — nothing started.\n');
    process.exit(1);
  }

  line(`\n  Starting daily owner briefing at ${String(HOUR).padStart(2, '0')}:00 ${TZ}\n`);

  let started = 0;
  let already = 0;
  let failed = 0;

  for (const o of orgs) {
    // Deterministic: one briefing schedule per org, forever. Re-running this
    // script must never produce a second briefing loop.
    const workflowId = `owner-briefing:${o.id}`;
    try {
      await client.workflow.start('OwnerBriefingWorkflow', {
        taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'darex-agent-tasks',
        workflowId,
        args: [{
          orgId: o.id,
          timeZone: TZ,
          hour: HOUR,
          recurring: true,
          idempotencyKey: workflowId,
        }],
      });
      started += 1;
      line(`   started   ${String(o.name).slice(0, 40)}`);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/already started|WorkflowExecutionAlreadyStarted/i.test(msg)) {
        already += 1;
        line(`   running   ${String(o.name).slice(0, 40)}`);
      } else {
        failed += 1;
        line(`   FAILED    ${String(o.name).slice(0, 40)} — ${msg.slice(0, 70)}`);
      }
    }
  }

  line(`\n  ${started} started, ${already} already running, ${failed} failed.`);
  line('  Each one sleeps until its next scheduled hour and continues itself.');
  line('  Nothing needs to stay open for this to happen again tomorrow.\n');
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  line(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
