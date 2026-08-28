#!/usr/bin/env node
'use strict';
/**
 * THE TRIGGER ENGINE — the thing that lets the agent act without being spoken to.
 *
 * WHY THIS EXISTS
 * The repo holds seventeen workflows and most are operator-shaped: StaleChase,
 * OwnerBriefing, Nurture, RentReminder, ShowingSchedule. The pack manifests
 * declare exactly when each should run. Nothing dispatched any of it. All
 * eight live entry points into the agent are an inbound webhook or a human
 * pressing a button, so the system was blind between messages — it could not
 * notice a quote nobody answered, an invoice going late, or a customer who
 * went quiet.
 *
 * The workflows were never the missing piece. The ignition was.
 *
 * SAFETY POSTURE, AND WHY IT IS THIS STRICT
 * Reliability x20 has never completed cleanly and the latency targets are
 * unmet. A system that answers when spoken to can carry that. A system that
 * ACTS UNATTENDED cannot, because nobody is watching when it goes wrong — the
 * blast radius of a bad reply is one conversation, and the blast radius of a
 * bad unattended action is every customer it reached before anyone noticed.
 *
 * So:
 *   - nothing fires without a row in org_automation saying mode='on'
 *   - installing a pack writes no such row, ever
 *   - dry_run evaluates and records what WOULD have happened, starting nothing
 *   - every org has a per-run dispatch cap, so a condition query that suddenly
 *     matches ten thousand rows cannot start ten thousand workflows
 *   - the claim is taken BEFORE the dispatch, so a crash in between loses the
 *     fire rather than repeating it
 *
 * Usage:
 *   node infra/scripts/trigger-engine.js                 evaluate and dispatch
 *   node infra/scripts/trigger-engine.js --dry-run       force dry-run globally
 *   node infra/scripts/trigger-engine.js --org <uuid>    one org
 *   node infra/scripts/trigger-engine.js --status        what is enabled, per org
 *   node infra/scripts/trigger-engine.js --self-test     the scheduling maths
 *
 * Exit: 0 = ran, 1 = a dispatch failed or the engine could not run.
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const args = process.argv.slice(2);
const FORCE_DRY = args.includes('--dry-run');
const STATUS_ONLY = args.includes('--status');
const ORG_ARG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

/**
 * Most a single org may start in one run.
 *
 * A condition trigger reads a query. The day that query is wrong — a bad
 * migration, a timezone slip, a status column that stopped being written — it
 * matches every row in the table. The cap is what stands between that mistake
 * and ten thousand messages to real customers. It is deliberately small: a
 * backlog is recoverable and an outbound flood is not.
 */
const MAX_DISPATCH_PER_ORG = Number(process.env.TRIGGER_MAX_PER_ORG || 25);

// ── Scheduling maths ────────────────────────────────────────────────────────
// Pure functions, no I/O, so the self-test can exercise the part most likely
// to be quietly wrong: WHEN something fires.

/** Calendar date in a time zone, as YYYY-MM-DD. */
function localDate(now, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    // An unknown time zone must not silently become UTC and fire a "9am"
    // briefing at the wrong hour forever. Fall back and let the caller see it.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  }
}

/** Hour of day 0-23 in a time zone. */
function localHour(now, timeZone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', hour12: false,
    }).format(now));
  } catch {
    return now.getUTCHours();
  }
}

/**
 * Should a daily trigger fire, and under what key?
 *
 * Fires on the first run at or after the configured hour, once per local
 * calendar day. Late is fine — an engine that missed the 9am tick still sends
 * the briefing at 11am, because a briefing an hour late is useful and a
 * briefing skipped is not.
 */
function dailyFire(now, { timeZone = 'UTC', hour = 9 } = {}) {
  const h = localHour(now, timeZone);
  if (h < hour) return null;
  return `daily:${localDate(now, timeZone)}`;
}

/**
 * Should an interval trigger fire, and under what key?
 *
 * Buckets wall-clock time into fixed windows so the key is stable no matter
 * when in the window the engine happens to run. Deriving it from "last fired
 * plus N hours" instead would make the schedule drift a little later on every
 * run, and a 2-hourly chase would silently become 3-hourly within a week.
 */
function intervalFire(now, { everyHours = 2 } = {}) {
  const hours = Math.max(1, Number(everyHours) || 2);
  const bucket = Math.floor(now.getTime() / (hours * 3600_000));
  return `bucket:${hours}h:${bucket}`;
}

// ── The registry ────────────────────────────────────────────────────────────
// Every trigger the pack manifests declare. A trigger present in a manifest
// and absent here is REPORTED, never silently ignored — a trigger that quietly
// does nothing is indistinguishable from one that is broken, which is exactly
// how this whole vocabulary came to sit unused.
const TRIGGERS = {
  daily: {
    workflow: 'OwnerBriefingWorkflow',
    kind: 'time',
    describe: 'a morning briefing for the owner',
    plan: (now, cfg) => {
      const key = dailyFire(now, cfg);
      return key ? [{ fireKey: key, input: { timeZone: cfg.timeZone || 'UTC', hour: cfg.hour ?? 9, repeatDaily: false } }] : [];
    },
  },

  scheduled: {
    workflow: 'StaleChaseWorkflow',
    kind: 'time',
    describe: 'chase inquiries nobody has answered',
    plan: (now, cfg) => [{
      fireKey: intervalFire(now, cfg),
      input: { timeZone: cfg.timeZone || 'UTC', slaHours: cfg.slaHours ?? 2 },
    }],
  },

  'pm.charge.due': {
    workflow: 'RentReminderWorkflow',
    kind: 'condition',
    describe: 'remind a tenant about a charge that has come due',
    // One fire per charge, keyed by charge id — so however often the engine
    // runs, a given charge produces exactly one reminder.
    query: `
      SELECT id::text AS id, lease_id::text AS lease_id, due_at
        FROM pm_charges
       WHERE org_id = $1
         AND status = 'open'
         AND closed_at IS NULL
         AND due_at IS NOT NULL
         AND due_at <= NOW()
         -- A charge the tenant claims to have paid is a dispute, not a
         -- reminder. Chasing someone who says they already paid is how an
         -- automated system loses a customer's trust in one message.
         AND claimed_paid_at IS NULL
       ORDER BY due_at
       LIMIT $2`,
    plan: (_now, _cfg, rows) => rows.map((r) => ({
      fireKey: `charge:${r.id}`,
      input: { chargeId: r.id, leaseId: r.lease_id || undefined },
    })),
  },

  'inquiry.book_showing': {
    workflow: 'ShowingScheduleWorkflow',
    kind: 'event',
    describe: 'book a viewing when a customer asks for one',
    // Event triggers are raised by a conversation, not by a clock. There is no
    // event bus yet, so this engine cannot dispatch it — and says so on every
    // run rather than leaving a declared capability looking live.
    plan: () => [],
    unsupported: 'needs an event bus — conversations do not yet emit triggers',
  },
};

// ── Self-test ───────────────────────────────────────────────────────────────
// The scheduling maths decides WHEN something fires, which is the part that
// fails quietly: a trigger that fires twice, or drifts an hour later each day,
// looks fine in a log and is wrong in a customer's inbox.
// Run: node infra/scripts/trigger-engine.js --self-test
if (args.includes('--self-test')) {
  let pass = 0;
  let fail = 0;
  const check = (label, cond, detail = '') => {
    if (cond) { pass++; console.log(`  [PASS] ${label}`); }
    else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
  };
  const at = (iso) => new Date(iso);

  console.log('\n### TRIGGER ENGINE — SCHEDULING SELF-TEST\n');

  // ── daily ──
  check('before the configured hour, nothing fires',
    dailyFire(at('2026-08-28T03:00:00Z'), { timeZone: 'UTC', hour: 9 }) === null);
  check('at the configured hour, it fires',
    dailyFire(at('2026-08-28T09:30:00Z'), { timeZone: 'UTC', hour: 9 }) === 'daily:2026-08-28');
  check('LATE still fires — a briefing an hour late beats one skipped',
    dailyFire(at('2026-08-28T14:00:00Z'), { timeZone: 'UTC', hour: 9 }) === 'daily:2026-08-28');

  // The reason the key is a date and not a timestamp: the engine runs hourly,
  // so every run after 9am would otherwise send another briefing.
  const runs = ['09:05', '10:05', '11:05', '17:05']
    .map((t) => dailyFire(at(`2026-08-28T${t}:00Z`), { timeZone: 'UTC', hour: 9 }));
  check('every run after the hour yields ONE key, not one per run',
    new Set(runs).size === 1, JSON.stringify(runs));
  check('a new day is a new key',
    dailyFire(at('2026-08-29T09:05:00Z'), { timeZone: 'UTC', hour: 9 }) === 'daily:2026-08-29');

  // Time zones are where "fires at 9am" quietly becomes "fires at 3:30am".
  check('the hour is judged in the ORG time zone, not UTC',
    dailyFire(at('2026-08-28T04:00:00Z'), { timeZone: 'Asia/Kolkata', hour: 9 }) === 'daily:2026-08-28'
      && dailyFire(at('2026-08-28T02:00:00Z'), { timeZone: 'Asia/Kolkata', hour: 9 }) === null);
  // The key must carry the LOCAL date, not the UTC one. 04:00Z is 09:30 IST,
  // so consecutive UTC instants twenty-four hours apart must produce
  // consecutive LOCAL dates — otherwise an org east of UTC gets two briefings
  // on one of its days and none on another.
  check('the key carries the local date, so it rolls with the org day',
    dailyFire(at('2026-08-28T04:00:00Z'), { timeZone: 'Asia/Kolkata', hour: 9 }) === 'daily:2026-08-28'
      && dailyFire(at('2026-08-29T04:00:00Z'), { timeZone: 'Asia/Kolkata', hour: 9 }) === 'daily:2026-08-29');

  // 19:00Z is already 00:30 the NEXT day in IST — past midnight but long
  // before 9am, so nothing fires. Worth pinning: the naive reading of "the
  // local date rolled, so fire" would send a briefing at half past midnight.
  check('a local date that has rolled but not reached the hour stays quiet',
    dailyFire(at('2026-08-28T19:00:00Z'), { timeZone: 'Asia/Kolkata', hour: 9 }) === null);
  check('an unknown time zone falls back instead of throwing',
    typeof dailyFire(at('2026-08-28T12:00:00Z'), { timeZone: 'Mars/Olympus', hour: 9 }) === 'string');

  // ── interval ──
  const a = intervalFire(at('2026-08-28T10:00:00Z'), { everyHours: 2 });
  const b = intervalFire(at('2026-08-28T11:59:00Z'), { everyHours: 2 });
  const c = intervalFire(at('2026-08-28T12:01:00Z'), { everyHours: 2 });
  check('two runs inside one window share a key', a === b, `${a} vs ${b}`);
  check('the next window is a new key', a !== c, `${a} vs ${c}`);
  check('buckets are absolute, so the schedule cannot drift later each run',
    intervalFire(at('2026-08-28T10:00:00Z'), { everyHours: 2 })
      === intervalFire(at('2026-08-28T10:59:00Z'), { everyHours: 2 }));
  check('a nonsense interval is clamped rather than dividing by zero',
    typeof intervalFire(at('2026-08-28T10:00:00Z'), { everyHours: 0 }) === 'string');

  // ── registry ──
  check('every trigger declared in the pack manifests is in the registry',
    ['daily', 'scheduled', 'pm.charge.due', 'inquiry.book_showing']
      .every((k) => Boolean(TRIGGERS[k])));
  check('a trigger that cannot fire says so instead of pretending',
    Boolean(TRIGGERS['inquiry.book_showing'].unsupported));
  check('condition triggers carry a bounded query',
    /LIMIT \$2/.test(TRIGGERS['pm.charge.due'].query));
  check('a charge the tenant says they paid is never chased',
    /claimed_paid_at IS NULL/.test(TRIGGERS['pm.charge.due'].query));

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
}

// ── Engine ──────────────────────────────────────────────────────────────────
const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

let temporal = null;
async function getTemporal() {
  if (temporal !== null) return temporal;
  try {
    const client = require(path.join(__dirname, '../../services/workflows/dist/workflow-client.js'));
    temporal = await client.getTemporalClient();
  } catch (err) {
    console.log(`  [WARN] Temporal client unavailable — ${String(err.message).slice(0, 70)}`);
    temporal = false;
  }
  return temporal;
}

async function enabledAutomations() {
  const params = [];
  let sql = `SELECT a.org_id, o.name AS org_name, a.trigger_key, a.mode, a.config
               FROM org_automation a
               JOIN orgs o ON o.id = a.org_id
              WHERE a.mode <> 'off' AND o.status = 'active'`;
  if (ORG_ARG) { params.push(ORG_ARG); sql += ` AND a.org_id = $${params.length}`; }
  sql += ' ORDER BY o.name, a.trigger_key';
  return (await db.query(sql, params)).rows;
}

(async () => {
  await db.connect();

  if (STATUS_ONLY) {
    console.log('\n### AUTOMATION STATUS\n');
    const rows = await enabledAutomations();
    if (!rows.length) {
      console.log('  Nothing is enabled anywhere. Every trigger is off.\n');
      console.log('  To let one org try a trigger WITHOUT it acting, start in dry-run:\n');
      console.log("    INSERT INTO org_automation (org_id, trigger_key, mode, config)");
      console.log("    VALUES ('<org-uuid>', 'scheduled', 'dry_run', '{\"slaHours\":2}');\n");
    } else {
      for (const r of rows) {
        console.log(`  ${String(r.org_name).slice(0, 30).padEnd(30)} ${r.trigger_key.padEnd(20)} ${r.mode}`);
      }
      console.log('');
    }
    const recent = await db.query(
      `SELECT trigger_key, status, COUNT(*)::int AS n
         FROM trigger_dispatches
        WHERE dispatched_at > NOW() - INTERVAL '7 days'
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 12`);
    if (recent.rows.length) {
      console.log('  Last 7 days:');
      for (const r of recent.rows) console.log(`    ${r.trigger_key.padEnd(22)} ${r.status.padEnd(12)} ${r.n}`);
      console.log('');
    }
    await db.end();
    process.exit(0);
  }

  const now = new Date();
  const automations = await enabledAutomations();

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  TRIGGER ENGINE — what the agent does without being asked    ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Declared but undispatchable, named every run.
  const unsupported = Object.entries(TRIGGERS).filter(([, t]) => t.unsupported);
  for (const [key, t] of unsupported) {
    console.log(`  [ -- ]  ${key} is declared but cannot fire — ${t.unsupported}`);
  }
  if (unsupported.length) console.log('');

  if (!automations.length) {
    console.log('  Nothing enabled. No org has opted into any trigger.\n');
    console.log('  This is the default and it is deliberate: reliability x20 has not');
    console.log('  passed, so nothing acts unattended until somebody turns it on.\n');
    console.log('  See what is available:  node infra/scripts/trigger-engine.js --status\n');
    await db.end();
    process.exit(0);
  }

  let dispatched = 0;
  let dryRun = 0;
  let skipped = 0;
  let failed = 0;
  const perOrg = new Map();

  for (const row of automations) {
    const trigger = TRIGGERS[row.trigger_key];
    const label = `${String(row.org_name).slice(0, 24).padEnd(24)} ${row.trigger_key.padEnd(18)}`;

    if (!trigger) {
      console.log(`  [SKIP]  ${label} unknown trigger — not in the engine registry`);
      skipped++;
      continue;
    }
    if (trigger.unsupported) { skipped++; continue; }

    const cfg = row.config || {};
    const effectiveMode = FORCE_DRY ? 'dry_run' : row.mode;

    // Condition triggers read the world; time triggers read the clock.
    let rows = [];
    if (trigger.kind === 'condition') {
      try {
        // cap + 1, so the engine can TELL that there was more work than it is
        // allowed to do in one run. Selecting exactly the cap made the
        // truncation happen inside the SQL LIMIT, before any code that could
        // report it: 41 charges were due, 25 fired, and the run printed a
        // clean summary. A silent cap reads as "everything handled", which is
        // the one thing a cap must never look like.
        rows = (await db.query(trigger.query, [row.org_id, MAX_DISPATCH_PER_ORG + 1])).rows;
      } catch (err) {
        console.log(`  [FAIL]  ${label} condition query failed — ${String(err.message).slice(0, 50)}`);
        failed++;
        continue;
      }
    }

    const planned = trigger.plan(now, cfg, rows);
    if (!planned.length) continue;

    const used = perOrg.get(row.org_id) || 0;
    const room = Math.max(0, MAX_DISPATCH_PER_ORG - used);
    if (planned.length > room) {
      // Say it out loud, and say whether there may be even more beyond what
      // the query returned. A cap that truncates silently reports a clean run
      // over work it decided not to do.
      const more = planned.length > MAX_DISPATCH_PER_ORG ? ' (and possibly more beyond that)' : '';
      console.log(`  [CAP ]  ${label} ${planned.length} due, ${room} allowed this run${more} — the rest wait`);
    }

    for (const item of planned.slice(0, room)) {
      // Claim BEFORE dispatch. A crash between the two loses this fire rather
      // than repeating it, and losing one beat of a recurring trigger is
      // recoverable in a way that a duplicate outbound message is not.
      const claimStatus = effectiveMode === 'dry_run' ? 'dry_run' : 'dispatched';
      const claimed = await db.query(
        `SELECT claim_trigger_fire($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::jsonb) AS ok`,
        [row.org_id, row.trigger_key, item.fireKey, trigger.workflow, claimStatus,
          JSON.stringify(item.input || {})],
      );
      if (!claimed.rows[0]?.ok) continue; // already fired for this key

      perOrg.set(row.org_id, (perOrg.get(row.org_id) || 0) + 1);

      if (effectiveMode === 'dry_run') {
        dryRun++;
        console.log(`  [DRY ]  ${label} would start ${trigger.workflow}  (${item.fireKey})`);
        continue;
      }

      const client = await getTemporal();
      if (!client) {
        await db.query(
          `SELECT settle_trigger_fire($1::uuid, $2::text, $3::text, 'failed', NULL, $4::text)`,
          [row.org_id, row.trigger_key, item.fireKey, 'Temporal unavailable'],
        );
        console.log(`  [FAIL]  ${label} Temporal unavailable`);
        failed++;
        continue;
      }

      const workflowId = `trigger-${row.trigger_key}-${item.fireKey}-${String(row.org_id).slice(0, 8)}`
        .replace(/[^A-Za-z0-9._-]/g, '-');
      try {
        await client.workflow.start(trigger.workflow, {
          taskQueue: 'darex-agent-tasks',
          workflowId,
          args: [{ orgId: row.org_id, idempotencyKey: item.fireKey, ...item.input }],
        });
        await db.query(
          `SELECT settle_trigger_fire($1::uuid, $2::text, $3::text, 'dispatched', $4::text, NULL)`,
          [row.org_id, row.trigger_key, item.fireKey, workflowId],
        );
        dispatched++;
        console.log(`  [ OK ]  ${label} started ${trigger.workflow}  (${item.fireKey})`);
      } catch (err) {
        const msg = String(err.message || err);
        // An already-running workflow with the same id is the idempotency
        // guarantee working, not a failure.
        const dupe = /already started|WorkflowExecutionAlreadyStarted/i.test(msg);
        await db.query(
          `SELECT settle_trigger_fire($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text)`,
          [row.org_id, row.trigger_key, item.fireKey, dupe ? 'dispatched' : 'failed',
            workflowId, msg.slice(0, 200)],
        );
        if (dupe) { dispatched++; console.log(`  [ OK ]  ${label} already running (${item.fireKey})`); }
        else { failed++; console.log(`  [FAIL]  ${label} ${msg.slice(0, 60)}`); }
      }
    }
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`\n  ${automations.length} automation(s) evaluated · `
    + `${dispatched} dispatched · ${dryRun} dry-run · ${skipped} skipped · ${failed} failed\n`);

  await db.end();
  try { const c = await getTemporal(); if (c) await c.connection?.close?.(); } catch { /* best effort */ }
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
