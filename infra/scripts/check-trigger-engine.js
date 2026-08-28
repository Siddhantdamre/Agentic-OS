#!/usr/bin/env node
'use strict';
/**
 * TRIGGER ENGINE — does it fire the right things, once, and only when allowed?
 *
 * This is the test that has to be right before anything acts unattended. A
 * reply gate protects one conversation; a trigger protects every customer the
 * agent can reach while nobody is watching. The failures that matter here are
 * not "it did not work" — those are obvious. They are:
 *
 *   - it fired for an org that never opted in
 *   - it fired twice because the scheduler ran twice
 *   - it chased a tenant who had already said they paid
 *   - a broken condition query matched everything and it messaged all of them
 *
 * Every case below is one of those. The engine is driven in dry_run for the
 * planning tests, because dry_run exercises the whole path — enablement,
 * condition query, fire key, claim, cap — and stops one line short of starting
 * a workflow. What it proves about safety is identical, and it does not spray
 * real workflows across a live Temporal namespace to prove it.
 *
 * Usage: node infra/scripts/check-trigger-engine.js
 * Exit:  0 = safe to enable, 1 = not
 */
const path = require('path');
const { spawnSync } = require('child_process');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const stamp = Date.now();
const ENGINE = path.join(__dirname, 'trigger-engine.js');

/** Run the engine over one org and return its stdout. */
function runEngine(orgId, extra = []) {
  const r = spawnSync(process.execPath, [ENGINE, '--org', orgId, ...extra], {
    encoding: 'utf8', env: process.env,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

async function dispatches(orgId, triggerKey = null) {
  const res = await db.query(
    `SELECT trigger_key, fire_key, status, workflow_name FROM trigger_dispatches
      WHERE org_id = $1 ${triggerKey ? 'AND trigger_key = $2' : ''}
      ORDER BY dispatched_at`,
    triggerKey ? [orgId, triggerKey] : [orgId],
  );
  return res.rows;
}

(async () => {
  await db.connect();
  console.log('\n=== TRIGGER ENGINE — SAFETY AND CORRECTNESS ===\n');

  const org = await db.query(
    `INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`Trigger Check ${stamp}`, `trigger-check-${stamp}`],
  );
  const orgId = org.rows[0].id;

  const other = await db.query(
    `INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`Trigger Neighbour ${stamp}`, `trigger-neighbour-${stamp}`],
  );
  const otherOrgId = other.rows[0].id;

  try {
    // ── 1. Opt-in is mandatory ──────────────────────────────────────────────
    console.log('1. Nothing fires without an explicit opt-in');
    let out = runEngine(orgId);
    let d = await dispatches(orgId);
    d.length === 0
      ? ok('a fresh org fires nothing', 'no org_automation row means off')
      : no('a fresh org fires nothing', `${d.length} dispatches`);

    // The dangerous default would be for pack install to imply consent.
    await db.query(
      `INSERT INTO org_packs (org_id, pack_id, status, installed_at)
       VALUES ($1, 'core-b2b', 'installed', NOW())`, [orgId]);
    runEngine(orgId);
    (await dispatches(orgId)).length === 0
      ? ok('installing a pack does NOT start anything', 'a pack says what an org COULD automate')
      : no('installing a pack does NOT start anything', 'pack install implied consent');

    // ── 2. dry_run plans without acting ─────────────────────────────────────
    console.log('\n2. dry_run shows the work without doing it');
    await db.query(
      `INSERT INTO org_automation (org_id, trigger_key, mode, config)
       VALUES ($1, 'scheduled', 'dry_run', '{"slaHours":2}'::jsonb)`, [orgId]);
    out = runEngine(orgId);
    d = await dispatches(orgId, 'scheduled');
    d.length === 1 && d[0].status === 'dry_run'
      ? ok('it planned one fire and recorded it as dry_run', d[0].fire_key)
      : no('it planned one fire and recorded it as dry_run', JSON.stringify(d));
    d[0]?.workflow_name === 'StaleChaseWorkflow'
      ? ok('the right workflow was chosen', 'scheduled -> StaleChaseWorkflow')
      : no('the right workflow was chosen', d[0]?.workflow_name);

    // ── 3. Once, however often the scheduler runs ───────────────────────────
    console.log('\n3. Once per window, however often the engine runs');
    runEngine(orgId);
    runEngine(orgId);
    runEngine(orgId);
    d = await dispatches(orgId, 'scheduled');
    d.length === 1
      ? ok('four runs produced ONE fire', 'the unique constraint is the guarantee, not the cron')
      : no('four runs produced ONE fire', `${d.length} fires`);

    // ── 4. A daily trigger fires once a day ─────────────────────────────────
    console.log('\n4. A daily briefing does not go out hourly');
    await db.query(
      `INSERT INTO org_automation (org_id, trigger_key, mode, config)
       VALUES ($1, 'daily', 'dry_run', '{"hour":0,"timeZone":"UTC"}'::jsonb)`, [orgId]);
    runEngine(orgId);
    runEngine(orgId);
    d = await dispatches(orgId, 'daily');
    d.length === 1 && /^daily:\d{4}-\d{2}-\d{2}$/.test(d[0].fire_key)
      ? ok('one fire, keyed by calendar date', d[0].fire_key)
      : no('one fire, keyed by calendar date', JSON.stringify(d));

    // ── 5. Condition triggers ───────────────────────────────────────────────
    console.log('\n5. A condition trigger reads the world, not the clock');
    await db.query(
      `INSERT INTO org_automation (org_id, trigger_key, mode, config)
       VALUES ($1, 'pm.charge.due', 'dry_run', '{}'::jsonb)`, [orgId]);

    const overdue = await db.query(
      `INSERT INTO pm_charges (org_id, kind, amount, currency, status, due_at)
       VALUES ($1, 'rent', 25000, 'INR', 'open', NOW() - INTERVAL '2 days') RETURNING id`, [orgId]);
    // Not yet due — must not fire.
    await db.query(
      `INSERT INTO pm_charges (org_id, kind, amount, currency, status, due_at)
       VALUES ($1, 'rent', 25000, 'INR', 'open', NOW() + INTERVAL '5 days')`, [orgId]);
    // Overdue, but the tenant says they paid. Chasing this loses a customer.
    await db.query(
      `INSERT INTO pm_charges (org_id, kind, amount, currency, status, due_at, claimed_paid_at)
       VALUES ($1, 'rent', 25000, 'INR', 'open', NOW() - INTERVAL '3 days', NOW())`, [orgId]);

    runEngine(orgId);
    d = await dispatches(orgId, 'pm.charge.due');
    d.length === 1
      ? ok('exactly the overdue charge fired', '1 of 3 charges')
      : no('exactly the overdue charge fired', `${d.length} fires`);
    d[0]?.fire_key === `charge:${overdue.rows[0].id}`
      ? ok('keyed by charge id, so one charge means one reminder ever')
      : no('keyed by charge id', d[0]?.fire_key);

    const chasedPaid = d.some((r) => r.fire_key.includes('claimed'));
    !chasedPaid && d.length === 1
      ? ok('a tenant who says they paid is never chased', 'that is a dispute, not a reminder')
      : no('a tenant who says they paid is never chased');

    // Re-running must not chase the same charge again.
    runEngine(orgId);
    (await dispatches(orgId, 'pm.charge.due')).length === 1
      ? ok('the same charge is not chased twice')
      : no('the same charge is not chased twice');

    // ── 6. The cap ──────────────────────────────────────────────────────────
    console.log('\n6. A runaway condition query cannot flood real customers');
    for (let i = 0; i < 40; i++) {
      await db.query(
        `INSERT INTO pm_charges (org_id, kind, amount, currency, status, due_at)
         VALUES ($1, 'rent', 1000, 'INR', 'open', NOW() - INTERVAL '1 day')`, [orgId]);
    }
    out = runEngine(orgId);
    const total = (await dispatches(orgId, 'pm.charge.due')).length;
    total <= 26
      ? ok('the per-run cap held', `${total} fires, cap 25 per run`)
      : no('the per-run cap held', `${total} fires — a bad query would have flooded`);
    /\[CAP \]/.test(out)
      ? ok('the cap says so out loud', 'silent truncation reads as a clean run')
      : no('the cap says so out loud', 'it truncated without telling anyone');

    // ── 7. Tenant isolation ─────────────────────────────────────────────────
    console.log('\n7. One org cannot see or trigger another');
    (await dispatches(otherOrgId)).length === 0
      ? ok('the neighbour org fired nothing')
      : no('the neighbour org fired nothing');

    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.current_org_id', $1, true)`, [otherOrgId]);
    await db.query('SET LOCAL ROLE darex_app');
    const leak = await db.query(
      `SELECT COUNT(*)::int AS n FROM trigger_dispatches WHERE org_id = $1`, [orgId]);
    await db.query('ROLLBACK');
    leak.rows[0].n === 0
      ? ok('a neighbour cannot read this org dispatch log', 'RLS holds on the new tables')
      : no('a neighbour cannot read this org dispatch log', `${leak.rows[0].n} rows visible`);

    // ── 8. off means off ────────────────────────────────────────────────────
    console.log('\n8. Turning it off stops it immediately');
    await db.query(
      `UPDATE org_automation SET mode = 'off' WHERE org_id = $1`, [orgId]);
    await db.query(`DELETE FROM trigger_dispatches WHERE org_id = $1`, [orgId]);
    runEngine(orgId);
    (await dispatches(orgId)).length === 0
      ? ok('mode=off fires nothing', 'revocation is instant, not next-cycle')
      : no('mode=off fires nothing');
  } finally {
    await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[orgId, otherOrgId]]);
    await db.end();
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
