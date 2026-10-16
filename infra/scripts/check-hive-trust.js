#!/usr/bin/env node
'use strict';
/**
 * HIVE TRUST, IN THE DATABASE — do the privacy protections hold where they are enforced?
 *
 * The simulation (simulate-hive-trust.js) shows the mechanism works on a model.
 * A model says nothing about whether Postgres actually refuses what the design
 * says it refuses, so this asserts the enforcement itself, as the real roles, on
 * a real database, with fake workspaces:
 *
 *   privileges    the app role cannot read releases or settings, write
 *                 contributions, publish, or read the noise key
 *   opt-in        off by default; nothing contributes or receives without it
 *   eligibility   free plan, new workspace, thin history: all refused
 *   correctness   contributions are computed from approval_requests, only for
 *                 graduatable classes, never from auto-approvals
 *   windows       no decision counted twice; a yearly budget per workspace
 *   k-threshold   below k, nothing is stored; an opt-out removes a workspace
 *   once          a release is computed once; repeating cannot re-noise it
 *   clipping      no workspace moves the aggregate by more than `clip`
 *   agreement     the SQL sampler and services/workflows/src/hive/privacy.ts
 *                 produce IDENTICAL releases for the same key and label
 *   reciprocity   only a sharing workspace receives a prior
 *   model SQL     database_query can neither read releases nor call the functions
 *
 * Fake data only, cleaned up in `finally`; settings are restored.
 *
 * Usage: node infra/scripts/check-hive-trust.js
 * Exit:  0 = enforced, 1 = something is not
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch {
  try { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }
  catch { Client = require(path.join(__dirname, '../../services/workflows/node_modules/pg')).Client; }
}
const dist = path.join(__dirname, '..', '..', 'services', 'workflows', 'dist');
const { makeRelease } = require(path.join(dist, 'hive', 'privacy.js'));
const { databaseQuery } = require(path.join(dist, 'tools', 'database.js'));
const { dbPool } = require(path.join(dist, 'tools', 'shared.js'));

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };
const check = (cond, m, d = '') => (cond ? ok(m, d) : no(m, d));

const base = { host: process.env.DB_HOST || '127.0.0.1', port: parseInt(process.env.DB_PORT || '5432', 10), database: process.env.DB_NAME || 'darex' };
const su = new Client({ ...base, user: process.env.DB_RESOLVER_USER || 'darex', password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret' });

/** Run `fn(client)` as the application role with `orgId` as the tenant context. */
async function asApp(orgId, fn) {
  const c = new Client({ ...base, user: process.env.DB_USER || 'darex_app', password: process.env.DB_PASSWORD || process.env.APP_DB_PASSWORD || 'darex_app_dev_secret' });
  await c.connect();
  try {
    if (orgId) await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    return await fn(c);
  } finally { await c.end(); }
}
const errOf = async (p) => { try { await p; return ''; } catch (e) { return e.message; } };

(async () => {
  await su.connect();
  console.log('\n### HIVE TRUST (database enforcement)\n');
  const stamp = Date.now();
  const made = [];
  const settings0 = Object.fromEntries((await su.query(`SELECT key, value FROM hive_settings`)).rows.map((r) => [r.key, r.value]));
  const setSetting = (k, v) => su.query(`UPDATE hive_settings SET value = $2 WHERE key = $1`, [k, String(v)]);

  const mkOrg = async (tag, { plan = 'starter', ageDays = 90 } = {}) => {
    const id = (await su.query(`INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [`Hive ${tag} ${stamp}`, `hive-${tag}-${stamp}`, plan])).rows[0].id;
    await su.query(`UPDATE orgs SET created_at = NOW() - make_interval(days => $2) WHERE id = $1`, [id, ageDays]);
    made.push(id);
    return id;
  };
  const decide = (org, cls, status, n, when = 'NOW() - INTERVAL \'2 days\'') => su.query(
    `INSERT INTO approval_requests (org_id, action_class, status, decided_at, summary)
     SELECT $1, $2, $3, ${when}, 's' FROM generate_series(1, $4)`, [org, cls, status, n]);
  const optIn = (org, on = true) => asApp(org, (c) => c.query(
    `INSERT INTO org_hive_optin (org_id, enabled, enabled_at) VALUES ($1, $2, NOW())
     ON CONFLICT (org_id) DO UPDATE SET enabled = $2, updated_at = NOW()`, [org, on]));
  const win = (fromDays, toDays) => [new Date(Date.now() - fromDays * 864e5).toISOString(), new Date(Date.now() - toDays * 864e5).toISOString()];
  const contribute = (org, epoch, [from, to], cohort = 'all') => asApp(org, (c) => c.query(`SELECT hive_contribute($1, $2, $3, $4, $5) AS n`, [org, epoch, from, to, cohort]));

  try {
    // Small numbers so the test is quick; restored in `finally`.
    await setSetting('k', 5); await setSetting('epsilon', 1); await setSetting('clip', 10);
    await setSetting('min_decided', 5); await setSetting('max_epochs_per_year', 3);

    // ── 1. Privileges ─────────────────────────────────────────────────────
    console.log('1. What the application role can and cannot touch');
    const O1 = await mkOrg('o1');
    for (const [label, sql] of [
      ['read released aggregates directly', 'SELECT * FROM hive_releases'],
      ['read the settings (and the noise key)', 'SELECT * FROM hive_settings'],
      ['read the noise key through the accessor', `SELECT hive_setting('noise_key')`],
      ['publish (combine workspaces)', `SELECT hive_publish('x')`],
      ['write a contribution of its own choosing', `INSERT INTO hive_contributions (org_id, action_class, epoch, approvals, rejections, window_start, window_end) VALUES ('${O1}', 'send', 'x', 1, 0, NOW() - INTERVAL '1 day', NOW())`],
      ['call the noise sampler', `SELECT hive_noise('k', 'l', 1, 10)`],
    ]) {
      const e = await asApp(O1, (c) => errOf(c.query(sql)));
      /permission denied/i.test(e) ? ok(`refused: ${label}`) : no(`refused: ${label}`, e || 'it ran');
    }

    // ── 2. Opt-in ─────────────────────────────────────────────────────────
    console.log('\n2. Opt-in is off by default and tenant-scoped');
    check((await asApp(O1, (c) => c.query('SELECT COUNT(*)::int AS n FROM org_hive_optin WHERE enabled'))).rows[0].n === 0, 'a new workspace is not opted in');
    await decide(O1, 'send', 'approved', 12); await decide(O1, 'send', 'rejected', 3);
    let e = await errOf(contribute(O1, 'E0', win(20, 5)));
    /has not opted in/.test(e) ? ok('an un-opted workspace cannot contribute') : no('an un-opted workspace cannot contribute', e || 'it did');
    const O2 = await mkOrg('o2');
    const cross = await asApp(O1, (c) => errOf(c.query(`INSERT INTO org_hive_optin (org_id, enabled) VALUES ($1, TRUE)`, [O2])));
    /row-level security/i.test(cross) ? ok('a workspace cannot opt ANOTHER workspace in (RLS)') : no('a workspace cannot opt another in', cross || 'it did');

    // ── 3. Eligibility ────────────────────────────────────────────────────
    console.log('\n3. Eligibility (sybil resistance)');
    const free = await mkOrg('free', { plan: 'free' }); await decide(free, 'send', 'approved', 10); await optIn(free);
    e = await errOf(contribute(free, 'E0', win(20, 5)));
    /free plan/.test(e) ? ok('a free-plan workspace is refused') : no('a free-plan workspace is refused', e || 'it contributed');
    const young = await mkOrg('young', { ageDays: 2 }); await decide(young, 'send', 'approved', 10); await optIn(young);
    e = await errOf(contribute(young, 'E0', win(20, 5)));
    /too new/.test(e) ? ok('a brand-new workspace is refused') : no('a brand-new workspace is refused', e || 'it contributed');
    const thin = await mkOrg('thin'); await decide(thin, 'send', 'approved', 2); await optIn(thin);
    e = await errOf(contribute(thin, 'E0', win(20, 5)));
    /decided requests/.test(e) ? ok('a workspace with a thin decision history is refused') : no('a thin history is refused', e || 'it contributed');
    await optIn(O1);
    const [wf, wt] = win(20, 5);
    e = await errOf(asApp(O1, (c) => c.query(`SELECT hive_contribute($1, 'E0', $2, $3, 'all')`, [O2, wf, wt])));
    /only for itself/.test(e) ? ok('a workspace cannot contribute on behalf of another') : no('a workspace cannot contribute for another', e || 'it did');

    // ── 4. Correctness: computed from the workspace's own decisions ───────
    console.log('\n4. Contributions are computed from approval_requests, not supplied');
    await decide(O1, 'pay', 'approved', 4);               // never graduates: must not be shared
    await decide(O1, 'send', 'auto_approved', 5);         // the AGENT acting, not a person's judgement
    await decide(O1, 'send', 'pending', 2);
    await decide(O1, 'price', 'approved', 6);
    await decide(O1, 'send', 'approved', 40, `NOW() - INTERVAL '100 days'`);   // outside the window
    const n1 = (await contribute(O1, 'E0', win(20, 1))).rows[0].n;
    const mine = (await asApp(O1, (c) => c.query(`SELECT action_class, approvals, rejections FROM hive_contributions ORDER BY 1`))).rows;
    check(n1 === 2 && JSON.stringify(mine) === JSON.stringify([{ action_class: 'price', approvals: 6, rejections: 0 }, { action_class: 'send', approvals: 12, rejections: 3 }]),
      'exactly the graduatable classes, human decisions only, inside the window', JSON.stringify(mine));
    check(!mine.some((r) => r.action_class === 'pay'), 'a class that never graduates (pay) is not shared');
    const again = (await contribute(O1, 'E0', win(20, 1))).rows[0].n;
    check(again === 0, 'contributing the same epoch again adds nothing', `${again} rows`);

    // ── 5. Windows and budget ─────────────────────────────────────────────
    console.log('\n5. No decision is counted twice; a yearly budget per workspace');
    e = await errOf(contribute(O1, 'E1', win(30, 0)));
    /overlaps/.test(e) ? ok('a window overlapping an earlier epoch is refused') : no('an overlapping window is refused', e || 'accepted');
    e = await errOf(contribute(O1, 'E1', win(120, 0)));
    /at most 31 days/.test(e) ? ok('a window longer than 31 days is refused') : no('a long window is refused', e || 'accepted');
    const B = await mkOrg('budget'); await optIn(B);
    // A decision inside each of four disjoint windows, 40 days apart, a year and a bit ago: the cap is 3 in this test.
    const bWin = (i) => [new Date(Date.now() - (400 - i * 40) * 864e5).toISOString(), new Date(Date.now() - (380 - i * 40) * 864e5).toISOString()];
    for (let i = 0; i < 4; i++) await decide(B, 'send', 'approved', 4, `NOW() - INTERVAL '${390 - i * 40} days'`);
    for (let i = 0; i < 3; i++) await contribute(B, `B${i}`, bWin(i));
    const spent = (await su.query(`SELECT COUNT(DISTINCT epoch)::int AS n FROM hive_contributions WHERE org_id = $1`, [B])).rows[0].n;
    e = await errOf(contribute(B, 'B3', bWin(3)));
    spent === 3 && /privacy budget/.test(e)
      ? ok('the per-workspace yearly epoch budget is enforced', 'cap 3 in this test, 12 by default')
      : no('the yearly budget is enforced', `${spent} epochs recorded; 4th: ${e || 'accepted'}`);

    // ── 6. k-threshold, opt-out, and "once" ───────────────────────────────
    console.log('\n6. Below k nothing exists; a release is computed once');
    const crowd = [O1];
    for (let i = 0; i < 5; i++) { const o = await mkOrg(`c${i}`); await decide(o, 'send', 'approved', 9); await decide(o, 'send', 'rejected', 1); await optIn(o); crowd.push(o); }
    // O1 already contributed E0; give four fresh workspaces E0 too: total 5 including O1.
    for (const o of crowd.slice(1, 5)) await contribute(o, 'E0', win(20, 1));
    const pub1 = (await su.query(`SELECT hive_publish('E0') AS n`)).rows[0].n;
    const cellSend = (await su.query(`SELECT * FROM hive_releases WHERE action_class = 'send' AND epoch = 'E0'`)).rows;
    const cellPrice = (await su.query(`SELECT * FROM hive_releases WHERE action_class = 'price' AND epoch = 'E0'`)).rows;
    check(cellSend.length === 1, 'five sharing workspaces meet k=5: a release exists', `${pub1} cell(s) published`);
    check(cellPrice.length === 0, 'a cell with only one contributor (price) stores NOTHING — not even a small number');
    const first = cellSend[0];
    const pub2 = (await su.query(`SELECT hive_publish('E0') AS n`)).rows[0].n;
    const after = (await su.query(`SELECT * FROM hive_releases WHERE action_class = 'send' AND epoch = 'E0'`)).rows[0];
    check(pub2 === 0 && after.approvals === first.approvals && after.rejections === first.rejections && String(after.published_at) === String(first.published_at),
      'publishing again changes nothing: the noise cannot be averaged away', `A=${first.approvals} R=${first.rejections}`);
    await optIn(crowd[1], false);   // one workspace leaves; a new epoch is published without it
    for (const o of crowd.slice(2, 5)) await contribute(o, 'E1', win(60, 40)).catch(() => {});
    const left = (await su.query(`SELECT COUNT(DISTINCT c.org_id)::int AS n FROM hive_contributions c JOIN org_hive_optin o ON o.org_id = c.org_id AND o.enabled WHERE c.epoch = 'E0' AND c.action_class = 'send'`)).rows[0].n;
    check(left === 4, 'a workspace that opts out stops counting toward k', `${left} sharing`);
    await su.query(`DELETE FROM hive_releases WHERE epoch = 'E0'`);
    const pub3 = (await su.query(`SELECT hive_publish('E0') AS n`)).rows[0].n;
    check(pub3 === 0 && (await su.query(`SELECT 1 FROM hive_releases WHERE epoch = 'E0'`)).rowCount === 0, 'after the opt-out the cell falls below k and is suppressed');
    await optIn(crowd[1], true);

    // ── 7. Clipping ───────────────────────────────────────────────────────
    console.log('\n7. No workspace moves the aggregate by more than the clip');
    await setSetting('epsilon', 1e9);   // noise is (effectively) zero so the arithmetic is visible
    const CL = 'clip-cohort';
    const small = [];
    for (let i = 0; i < 5; i++) { const o = await mkOrg(`cl${i}`); await optIn(o); small.push(o); await su.query(`INSERT INTO hive_contributions (org_id, action_class, cohort, epoch, approvals, rejections, window_start, window_end) VALUES ($1,'send',$2,'CL',6,2,NOW()-INTERVAL '10 days',NOW()-INTERVAL '5 days')`, [o, CL]); }
    await su.query(`SELECT hive_publish('CL')`);
    const noHeavy = (await su.query(`SELECT approvals, rejections FROM hive_releases WHERE epoch = 'CL' AND cohort = $1`, [CL])).rows[0];
    check(noHeavy && noHeavy.approvals === 30 && noHeavy.rejections === 10, 'five workspaces of 6 and 2: the aggregate is exactly 30 and 10', JSON.stringify(noHeavy));
    const heavy = await mkOrg('heavy'); await optIn(heavy);
    await su.query(`INSERT INTO hive_contributions (org_id, action_class, cohort, epoch, approvals, rejections, window_start, window_end) VALUES ($1,'send',$2,'CL2',9000000,3000000,NOW()-INTERVAL '10 days',NOW()-INTERVAL '5 days')`, [heavy, CL]);
    for (const o of small) await su.query(`INSERT INTO hive_contributions (org_id, action_class, cohort, epoch, approvals, rejections, window_start, window_end) VALUES ($1,'send',$2,'CL2',6,2,NOW()-INTERVAL '10 days',NOW()-INTERVAL '5 days')`, [o, CL]);
    await su.query(`SELECT hive_publish('CL2')`);
    const withHeavy = (await su.query(`SELECT approvals, rejections FROM hive_releases WHERE epoch = 'CL2' AND cohort = $1`, [CL])).rows[0];
    const shift = (withHeavy.approvals + withHeavy.rejections) - (noHeavy.approvals + noHeavy.rejections);
    check(shift === 10, 'a workspace with twelve million decisions adds exactly `clip` (10) to the total', `shift ${shift}`);
    const rate = withHeavy.approvals / (withHeavy.approvals + withHeavy.rejections);
    check(rate > 0.68 && rate < 0.82, 'and clipping keeps its rate (75%) instead of flattening it', `${(rate * 100).toFixed(1)}%`);
    await setSetting('epsilon', 1);

    // ── 8. SQL and TypeScript agree, bit for bit ──────────────────────────
    console.log('\n8. The SQL sampler and the TypeScript reference produce identical releases');
    const key = (await su.query(`SELECT value FROM hive_settings WHERE key = 'noise_key'`)).rows[0].value;
    const AG = 'agree-cohort';
    const ags = [];
    for (let i = 0; i < 30; i++) { const o = await mkOrg(`ag${i}`); await optIn(o); ags.push(o); }
    let mismatches = 0; const EPOCHS = 200; let rng = 1234567;
    const rand = () => { rng = (Math.imul(rng, 1103515245) + 12345) >>> 0; return rng / 4294967296; };
    for (let e2 = 0; e2 < EPOCHS; e2++) {
      const rows = ags.map((o) => ({ orgId: o, optedIn: true, approvals: Math.floor(rand() * 40), rejections: Math.floor(rand() * 6) }));
      for (const r of rows) await su.query(`INSERT INTO hive_contributions (org_id, action_class, cohort, epoch, approvals, rejections, window_start, window_end) VALUES ($1,'send',$2,$3,$4,$5,NOW()-INTERVAL '10 days',NOW()-INTERVAL '5 days')`, [r.orgId, AG, `AG${e2}`, r.approvals, r.rejections]);
      await su.query(`SELECT hive_publish($1)`, [`AG${e2}`]);
      const sqlRel = (await su.query(`SELECT approvals, rejections FROM hive_releases WHERE epoch = $1 AND cohort = $2`, [`AG${e2}`, AG])).rows[0];
      const tsRel = makeRelease(rows, { k: 5, clip: 10, epsilon: 1, key, label: `send|${AG}|AG${e2}` });
      if (!sqlRel || tsRel.suppressed || sqlRel.approvals !== tsRel.approvals || sqlRel.rejections !== tsRel.rejections) mismatches++;
    }
    check(mismatches === 0, `${EPOCHS} independent releases: SQL == TypeScript`, mismatches ? `${mismatches} differ` : 'identical clipping, rounding and noise');

    // ── 9. Reciprocity ────────────────────────────────────────────────────
    console.log('\n9. Only a sharing workspace receives the prior');
    const rel = (await su.query(`SELECT approvals, rejections FROM hive_releases WHERE epoch = 'CL2'`)).rows.length;
    void rel;
    const sharing = small[0];
    const got = (await asApp(sharing, (c) => c.query(`SELECT * FROM hive_prior_for($1, 'send', $2)`, [sharing, CL]))).rows;
    check(got.length === 1 && got[0].out_at_least_k === 5, 'a sharing workspace receives the latest release', got[0] ? `epoch ${got[0].out_epoch}, at least ${got[0].out_at_least_k} workspaces` : 'none');
    const loner = await mkOrg('loner');
    const none = (await asApp(loner, (c) => c.query(`SELECT * FROM hive_prior_for($1, 'send', $2)`, [loner, CL]))).rows;
    check(none.length === 0, 'a workspace that does not share receives nothing');
    e = await errOf(asApp(sharing, (c) => c.query(`SELECT * FROM hive_prior_for($1, 'send', $2)`, [loner, CL])));
    /ask only for itself/.test(e) ? ok('a workspace cannot ask on behalf of another') : no('a workspace cannot ask on behalf of another', e || 'it could');

    // ── 10. Model-written SQL ─────────────────────────────────────────────
    console.log('\n10. The model-facing SQL tool cannot reach any of it');
    // Straight to the SQL tool: this repo's gate refuses a bare fake tenant, and the gate is a separate layer.
    const ask = (org, sql) => databaseQuery.execute({ tool: 'database_query', action: 'query', actionName: 'query', orgId: org, payload: { sql }, timestamp: new Date().toISOString() });
    let r = await ask(sharing, 'SELECT * FROM hive_releases');
    r.status === 'error' && /permission denied/i.test(r.message) ? ok('hive_releases is unreadable to model SQL') : no('hive_releases is unreadable to model SQL', `${r.status} ${r.message}`);
    r = await ask(sharing, 'SELECT * FROM hive_settings');
    r.status === 'error' && /permission denied/i.test(r.message) ? ok('hive_settings (the noise key) is unreadable to model SQL') : no('hive_settings is unreadable', `${r.status} ${r.message}`);
    r = await ask(sharing, `SELECT * FROM hive_prior_for('${sharing}', 'send', 'x')`);
    r.status === 'error' && /^Security Policy/.test(r.message) ? ok('hive_prior_for is refused before it reaches the database') : no('hive_prior_for is refused', `${r.status} ${r.message}`);
    r = await ask(sharing, `SELECT hive_publish('CL')`);
    r.status === 'error' && /^Security Policy/.test(r.message) ? ok('hive_publish is refused before it reaches the database') : no('hive_publish is refused', `${r.status} ${r.message}`);
    r = await ask(sharing, 'SELECT DISTINCT org_id FROM hive_contributions');
    r.status === 'executed' && r.data.rows.length === 1 && r.data.rows[0].org_id === sharing ? ok('model SQL sees only its own contributions (RLS)') : no('model SQL sees only its own contributions', JSON.stringify(r.data && r.data.rows) || r.message);

    // ── 11. Erasure ───────────────────────────────────────────────────────
    console.log('\n11. Erasing a workspace removes what it contributed');
    const before = (await su.query(`SELECT COUNT(*)::int AS n FROM hive_contributions WHERE org_id = $1`, [sharing])).rows[0].n;
    await su.query(`DELETE FROM orgs WHERE id = $1`, [sharing]);
    const gone = (await su.query(`SELECT COUNT(*)::int AS n FROM hive_contributions WHERE org_id = $1`, [sharing])).rows[0].n;
    check(before > 0 && gone === 0, 'deleting the workspace deletes its contributions', `${before} -> ${gone}`);
    info('A release already published cannot be "un-mixed"; that is what the noise and the k-threshold are for. See docs/adr/023.');
  } finally {
    for (const [k, v] of Object.entries(settings0)) await su.query(`UPDATE hive_settings SET value = $2 WHERE key = $1`, [k, v]).catch(() => {});
    await su.query(`DELETE FROM hive_releases WHERE cohort IN ('clip-cohort', 'agree-cohort') OR epoch IN ('E0','E1','CL','CL2')`).catch(() => {});
    await su.query(`DELETE FROM orgs WHERE id = ANY($1)`, [made]).catch((e) => console.log('cleanup:', e.message));
    await su.end();
    await dbPool.end().catch(() => {});
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

function info(m) { console.log(`  [INFO] ${m}`); }
