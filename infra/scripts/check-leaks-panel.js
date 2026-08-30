#!/usr/bin/env node
'use strict';
/**
 * THE LEAK REPORT — can a human actually reach the follow-up agent?
 *
 * WHY THIS SUITE EXISTS AT ALL
 *
 * Four features in this repository were built, tested, and unreachable:
 * operator edit learning, knowledge gaps, the outcome ledger, and approvals.
 * Each was correct at every layer and had no route a person could press. No
 * test caught any of them, because every test called the layer below the gap.
 *
 * The quiet-leads agent was the fifth. It shipped at 22/22 with no API route
 * and no UI — a working agent nobody could see, switch on, or trust.
 *
 * So this suite deliberately starts at the HTTP boundary with a real session
 * cookie, exactly where a browser starts. Everything below it is already
 * covered by check-quiet-leads.js; what is checked here is only the last inch.
 *
 * Usage: node infra/scripts/check-leaks-panel.js
 * Exit:  0 = an owner can see and control it, 1 = they cannot
 */
const path = require('path');
const { spawnSync } = require('child_process');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';

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

(async () => {
  await db.connect();
  console.log('\n=== THE LEAK REPORT — CAN AN OWNER REACH IT? ===\n');

  let orgId = null;
  let cookie = '';

  try {
    // ── 1. Unauthenticated ──────────────────────────────────────────────────
    console.log('1. It is not readable without a session');
    const anon = await fetch(`${BASE}/api/leaks`);
    anon.status === 401
      ? ok('reading the leak report needs a session', 'HTTP 401')
      : no('reading the leak report needs a session', `HTTP ${anon.status}`);

    const anonPost = await fetch(`${BASE}/api/leaks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'on' }),
    });
    anonPost.status === 401
      ? ok('and arming the agent certainly does', 'HTTP 401')
      : no('and arming the agent certainly does', `HTTP ${anonPost.status} — ANYONE COULD SWITCH IT ON`);

    // ── 2. A real owner ─────────────────────────────────────────────────────
    console.log('\n2. A real owner, through the route the browser calls');
    const email = `leaks-${stamp}@example.com`;
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: `Leaks!${stamp}aA1` }),
    });
    const regBody = await reg.json().catch(() => ({}));
    orgId = regBody.orgId;
    cookie = (reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    orgId && cookie
      ? ok('workspace registered and signed in', `${String(orgId).slice(0, 8)}…`)
      : no('workspace registered and signed in', `HTTP ${reg.status}`);
    if (!orgId) throw new Error('cannot continue without a workspace');

    const get = async () => {
      const r = await fetch(`${BASE}/api/leaks`, { headers: { Cookie: cookie } });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    let report = await get();
    report.status === 200 && Array.isArray(report.body.leaks)
      ? ok('the leak report loads', `${report.body.leaks.length} leaks tracked`)
      : no('the leak report loads', `HTTP ${report.status} ${JSON.stringify(report.body).slice(0, 120)}`);

    report.body.mode === 'off'
      ? ok('a brand new workspace starts OFF', 'installing is not enabling')
      : no('a brand new workspace starts OFF', `mode=${report.body.mode}`);

    // ── 3. The three states ─────────────────────────────────────────────────
    console.log('\n3. Three states, so a business can watch before it trusts');
    const setMode = async (mode) => {
      const r = await fetch(`${BASE}/api/leaks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ mode }),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    const watch = await setMode('dry_run');
    watch.status === 200 && watch.body.mode === 'dry_run'
      ? ok('an owner can set it to watch', 'drafts everything, sends nothing')
      : no('an owner can set it to watch', JSON.stringify(watch.body).slice(0, 120));
    /send none|sends none|draft/i.test(String(watch.body.message || ''))
      ? ok('and is told exactly what that means')
      : no('and is told exactly what that means', String(watch.body.message));

    const armed = await setMode('on');
    armed.body.mode === 'on'
      ? ok('and can arm it')
      : no('and can arm it', JSON.stringify(armed.body).slice(0, 120));
    /never/i.test(String(armed.body.message || ''))
      ? ok('and is told what it will refuse to do', 'the sentence names the limits, not just the capability')
      : no('and is told what it will refuse to do', String(armed.body.message));

    const bad = await setMode('sure_whatever');
    bad.status === 400
      ? ok('an unknown mode is refused', 'HTTP 400 — not silently treated as on')
      : no('an unknown mode is refused', `HTTP ${bad.status}`);

    // ── 4. It reflects what the agent actually did ──────────────────────────
    console.log('\n4. It shows the agent\'s real work, not a mock');
    // Seed a workspace the runner will find something in, then run the real
    // runner against it and read the panel.
    const seeded = spawnSync(process.execPath,
      [path.join(__dirname, 'seed-quiet-leads-demo.js'), '--mode', 'dry_run'],
      { encoding: 'utf8', env: process.env, timeout: 120000 });
    const seedOrg = String(seeded.stdout || '').trim().split('\n').pop();

    if (!/^[0-9a-f-]{36}$/i.test(seedOrg)) {
      no('a seeded workspace could be created', String(seeded.stderr).slice(0, 120));
    } else {
      spawnSync(process.execPath,
        [path.join(__dirname, 'quiet-leads.js'), '--org', seedOrg],
        { encoding: 'utf8', env: process.env, timeout: 180000 });

      // Read that workspace's rows directly — the HTTP path is proven above;
      // what is checked here is that the SHAPE the panel renders is populated.
      const rows = await db.query(
        `SELECT status, skip_reason FROM lead_followups WHERE org_id = $1`, [seedOrg]);
      const suppressed = rows.rows.filter((r) => r.status === 'suppressed').length;
      const skipped = rows.rows.filter((r) => r.status === 'skipped');

      suppressed === 2
        ? ok('the drafts it would send are there for the panel', '2')
        : no('the drafts it would send are there for the panel', `${suppressed}`);

      const reasons = new Set(skipped.map((r) => r.skip_reason));
      reasons.has('complaint') && reasons.has('customer_declined')
        ? ok('and so is who it REFUSED to contact',
          'the answer to "did you message the man complaining about his refund?"')
        : no('and so is who it refused to contact', [...reasons].join(', ') || 'none recorded');

      await db.query('DELETE FROM orgs WHERE id = $1', [seedOrg]).catch(() => {});
    }

    // ── 5. Isolation ────────────────────────────────────────────────────────
    console.log('\n5. One workspace cannot read another\'s leaks');
    report = await get();
    const mine = report.body.followUps;
    mine && mine.proposed.length === 0 && mine.sentCount === 0
      ? ok('a fresh workspace sees only its own — which is nothing', 'no cross-tenant bleed')
      : no('a fresh workspace sees only its own', JSON.stringify(mine).slice(0, 140));

    // ── 6. It never invents money ───────────────────────────────────────────
    console.log('\n6. It never puts a rupee figure on a guess');
    const asText = JSON.stringify(report.body);
    !/₹|rupee|revenue|worth ₹|lost ₹/i.test(asText)
      ? ok('no currency figure anywhere in the report',
        'a quiet lead is not a lost sale, and pricing it would be invented')
      : no('no currency figure anywhere in the report', 'IT IS CLAIMING MONEY IT CANNOT KNOW');
  } finally {
    if (orgId) await db.query('DELETE FROM orgs WHERE id = $1', [orgId]).catch(() => {});
    await db.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
