#!/usr/bin/env node
'use strict';
/**
 * THREE ROLES ON EVERY TASK — and proof all three reported.
 *
 * The doer, the monitor and the learner ran on every work item long before
 * this suite existed. What did not exist was any way to confirm it: their
 * traces were scattered across a dozen work_event kinds, so "was this task
 * supervised?" meant reconstructing a timeline and hoping nothing was missing.
 *
 * A supervisor nobody can confirm ran is indistinguishable from one that
 * silently stopped. That is how four features in this codebase came to be
 * built, tested, and unreachable — so the check here is deliberately the
 * blunt one: A COMPLETED TASK WITH NO SUPERVISION ROW IS A FAILURE.
 *
 * Usage: node infra/scripts/check-supervision.js
 * Exit:  0 = every task reports its trio, 1 = one did not
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const { judgeTask, summariseSupervision } =
  require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'supervision', 'trio.js'));

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const cfg = (user, password) => ({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user, password, database: process.env.DB_NAME || 'darex',
});
const db = new Client(cfg(
  process.env.DB_RESOLVER_USER || 'darex',
  process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret'));
const app = new Client(cfg(
  process.env.DB_USER || 'darex_app', process.env.DB_PASSWORD || 'darex_app_dev_secret'));

const stamp = Date.now();

(async () => {
  await db.connect();
  await app.connect();
  console.log('\n=== SUPERVISION — DID ALL THREE ROLES REPORT? ===\n');

  const orgs = [];
  try {
    const mk = async (tag) => {
      const id = (await db.query(
        `INSERT INTO orgs (name, slug) VALUES ($1,$1) RETURNING id`, [`sup-${tag}-${stamp}`])).rows[0].id;
      orgs.push(id);
      return id;
    };
    const A = await mk('a');
    const B = await mk('b');

    const workItem = async (orgId) => (await db.query(
      `INSERT INTO work_items (org_id, type, status, channel)
       VALUES ($1,'conversation','done','inbox') RETURNING id`, [orgId])).rows[0].id;

    const record = async (orgId, wi, over = {}) => {
      const v = judgeTask({
        replyProduced: true, refused: false, escalated: false, turns: 1,
        criticBlocked: false, criticRevised: false, criticReason: '', criticUsedModel: false,
        gapRecorded: false, memoryWritten: false, ...over,
      });
      await db.query(
        `SELECT record_task_supervision($1::uuid,$2::uuid,NULL,$3::text,$4::int,$5::text,$6::text,$7::boolean,$8::text,$9::boolean)`,
        [orgId, wi, v.doerOutcome, v.doerTurns, v.monitorVerdict, v.monitorReason,
          v.monitorUsedModel, v.learnerOutcome, v.learnerFromMonitor]);
      return v;
    };

    // ── 1. The trio is recorded ─────────────────────────────────────────────
    console.log('1. A task records what all three roles did');
    const wi1 = await workItem(A);
    const v1 = await record(A, wi1);
    const row = (await db.query(
      `SELECT * FROM task_supervision WHERE work_item_id = $1`, [wi1])).rows[0];
    row && row.doer_outcome === 'replied' && row.monitor_verdict === 'passed'
      ? ok('one row, three verdicts', `${row.doer_outcome} / ${row.monitor_verdict} / ${row.learner_outcome}`)
      : no('one row, three verdicts', JSON.stringify(row));
    /answered.*let it through.*nothing new/i.test(v1.summary)
      ? ok('and a sentence an operator can read', v1.summary)
      : no('and a sentence an operator can read', v1.summary);

    // ── 2. A refusal is not a failure ───────────────────────────────────────
    console.log('\n2. A deliberate refusal is recorded as one');
    const wi2 = await workItem(A);
    await record(A, wi2, { refused: true });
    const r2 = (await db.query(
      `SELECT doer_outcome FROM task_supervision WHERE work_item_id=$1`, [wi2])).rows[0];
    r2.doer_outcome === 'refused'
      ? ok('a security refusal is `refused`, not `failed`',
        'filing it as a failure makes the safest agent look like the worst')
      : no('a security refusal is `refused`', r2.doer_outcome);

    // ── 3. Nothing produced is skipped, not passed ──────────────────────────
    console.log('\n3. The monitor never claims a judgement it did not make');
    const wi3 = await workItem(A);
    await record(A, wi3, { replyProduced: false });
    const r3 = (await db.query(
      `SELECT monitor_verdict FROM task_supervision WHERE work_item_id=$1`, [wi3])).rows[0];
    r3.monitor_verdict === 'skipped'
      ? ok('an empty reply is `skipped`', 'a pass rate built on silence is not a pass rate')
      : no('an empty reply is `skipped`', r3.monitor_verdict);

    // ── 4. The loop ─────────────────────────────────────────────────────────
    console.log('\n4. The loop: did being judged teach it anything?');
    const wi4 = await workItem(A);
    await record(A, wi4, { criticBlocked: true, gapRecorded: true });
    const r4 = (await db.query(
      `SELECT learner_from_monitor FROM task_supervision WHERE work_item_id=$1`, [wi4])).rows[0];
    r4.learner_from_monitor === true
      ? ok('a block that produced a gap is a closed loop')
      : no('a block that produced a gap is a closed loop');

    const wi5 = await workItem(A);
    await record(A, wi5, { gapRecorded: true });
    const r5 = (await db.query(
      `SELECT learner_from_monitor FROM task_supervision WHERE work_item_id=$1`, [wi5])).rows[0];
    r5.learner_from_monitor === false
      ? ok('a gap on a PASSED task is not', 'two things on the same afternoon is not causation')
      : no('a gap on a passed task is not a closed loop');

    // ── 5. Replay safety ────────────────────────────────────────────────────
    console.log('\n5. A Temporal replay reproduces the row, never doubles it');
    await record(A, wi1);
    await record(A, wi1);
    const dupes = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM task_supervision WHERE work_item_id=$1`, [wi1])).rows[0].n);
    dupes === 1
      ? ok('three recordings of one task produce one row', 'upsert assigns, never accumulates')
      : no('three recordings of one task produce one row', `${dupes} rows`);

    // ── 6. THE BLUNT CHECK, ON EVERY TERMINAL STATUS ────────────────────────
    // This used to read `w.status = 'done'` only. The workflow has THREE
    // terminal statuses, and the two it ignored are where supervision matters
    // most:
    //
    //   done            finished cleanly
    //   needs_attention failed, or escalated to a person   <- was invisible
    //   cancelled       stopped deliberately               <- was invisible
    //
    // Ten returns in WorkItemWorkflow exited before supervision was recorded;
    // eight of them landed in the two statuses this check never looked at. A
    // supervisor that sees only successes does not measure quality, it measures
    // how often nothing went wrong and reports that as the same thing.
    console.log('\n6. A finished task with NO supervision row is a failure — whatever it finished as');
    const TERMINAL = ['done', 'needs_attention', 'cancelled'];
    for (const status of TERMINAL) {
      const orphan = (await db.query(
        `INSERT INTO work_items (org_id, type, status, channel)
         VALUES ($1,'conversation',$2,'inbox') RETURNING id`, [A, status])).rows[0].id;
      const missed = Number((await db.query(
        `SELECT COUNT(*)::int AS n FROM work_items w
          WHERE w.org_id = $1 AND w.status = ANY($2::text[])
            AND NOT EXISTS (SELECT 1 FROM task_supervision t WHERE t.work_item_id = w.id)`,
        [A, TERMINAL])).rows[0].n);
      missed === 1
        ? ok(`an unsupervised '${status}' task is detected`,
          status === 'done' ? 'a missing row IS the signal' : 'previously invisible to this check')
        : no(`an unsupervised '${status}' task is detected`, `${missed} found, expected 1`);
      await db.query(`DELETE FROM work_items WHERE id=$1`, [orphan]);
    }

    // ── 7. Reading it ───────────────────────────────────────────────────────
    console.log('\n7. The numbers refuse to flatter');
    const rows = (await db.query(
      `SELECT monitor_verdict, doer_outcome, learner_from_monitor, monitor_used_model
         FROM task_supervision WHERE org_id=$1`, [A])).rows
      .map((r) => ({
        monitorVerdict: r.monitor_verdict, doerOutcome: r.doer_outcome,
        learnerFromMonitor: r.learner_from_monitor, monitorUsedModel: r.monitor_used_model,
      }));
    const stats = summariseSupervision(rows);
    stats.interventionRatePct === null
      ? ok('no rate is quoted from a handful of tasks', `${stats.tasks} task(s), rate withheld`)
      : no('no rate is quoted from a handful of tasks', `${stats.interventionRatePct}%`);
    /Too few/.test(stats.headline)
      ? ok('and it says so in words', stats.headline)
      : no('and it says so in words', stats.headline);

    // ── 8. Isolation ────────────────────────────────────────────────────────
    console.log('\n8. One workspace cannot read another\'s supervision');
    await app.query("SELECT set_config('app.current_org_id', $1, false)", [B]);
    const leak = Number((await app.query(
      `SELECT COUNT(*)::int AS n FROM task_supervision WHERE org_id = $1`, [A])).rows[0].n);
    leak === 0
      ? ok('reading another workspace returns nothing', 'asserted as darex_app under RLS')
      : no('reading another workspace returns nothing', `${leak} row(s) leaked`);

    console.log('\n─── WHAT THE TRIO REPORTED ───\n');
    for (const r of (await db.query(
      `SELECT doer_outcome, monitor_verdict, learner_outcome, learner_from_monitor
         FROM task_supervision WHERE org_id=$1 ORDER BY created_at`, [A])).rows) {
      console.log(`  doer=${String(r.doer_outcome).padEnd(9)} monitor=${String(r.monitor_verdict).padEnd(8)}`
        + ` learner=${String(r.learner_outcome).padEnd(14)}${r.learner_from_monitor ? ' (loop closed)' : ''}`);
    }
    console.log('');
  } finally {
    if (orgs.length) await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [orgs]).catch(() => {});
    await db.end().catch(() => {});
    await app.end().catch(() => {});
  }

  console.log(`  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  try { await app.end(); } catch { /* closed */ }
  process.exit(1);
});
