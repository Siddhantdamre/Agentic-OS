#!/usr/bin/env node
'use strict';
/**
 * EARNED AUTONOMY — can the agent be trusted with more, safely?
 *
 * Measured on this database before any of it existed:
 *
 *   work_items status = 'waiting_approval'    24
 *   work_events kind  = 'confirm_requested'   24
 *   work_events kind  = 'confirm_approved'     0     oldest waiting 13 days
 *
 * The agent asked twenty-four times and could never be answered, because
 * nothing could send the approveWorkItem signal. This is the test for the
 * handle that door never had, and for the mechanism that lets the agent
 * gradually stop needing it.
 *
 * The failures that matter are not "approval did not work". They are:
 *
 *   - a class that should NEVER stop asking quietly graduating
 *   - a rejection not costing the agent its accumulated trust
 *   - one tenant's approvals granting another tenant's agent permission
 *   - a decision being lost because the workflow had already timed out
 *
 * That last one is the whole reason the record is durable rather than a
 * signal: humans do not answer in two minutes.
 *
 * Usage: node infra/scripts/check-approvals.js
 * Exit:  0 = trustworthy, 1 = not
 */
const path = require('path');
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
let seq = 0;

/** Queue an approval exactly as the workflow does. */
async function request(orgId, actionClass, workflowId = null) {
  const workItemId = (await db.query(
    `INSERT INTO work_items (org_id, type, status, channel)
     VALUES ($1, 'conversation', 'waiting_approval', 'inbox') RETURNING id`,
    [orgId],
  )).rows[0].id;
  const r = await db.query(
    `SELECT record_approval_request($1::uuid, $2::uuid, NULL, $3::text,
                                     $4::text, '', $5::text) AS id`,
    [orgId, workItemId, actionClass, `agent wants to ${actionClass} (#${seq++})`, workflowId],
  );
  return r.rows[0].id;
}

async function decide(cookie, id, decision, reason) {
  const res = await fetch(`${BASE}/api/approvals/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ decision, reason }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function level(orgId, actionClass) {
  const r = await db.query(
    `SELECT autonomy_level_for($1::uuid, $2::text) AS level`, [orgId, actionClass]);
  return r.rows[0].level;
}

(async () => {
  await db.connect();
  console.log('\n=== EARNED AUTONOMY — CAN IT BE TRUSTED WITH MORE? ===\n');

  const mk = async (tag) => {
    const email = `appr-${tag}-${stamp}@example.com`;
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: `Appr!${stamp}aA1` }),
    });
    const b = await r.json().catch(() => ({}));
    const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    return { orgId: b.orgId, cookie };
  };

  const A = await mk('a');
  const B = await mk('b');
  if (!A.orgId || !B.orgId) throw new Error('could not register test tenants');

  try {
    // ── 1. The door has a handle ────────────────────────────────────────────
    console.log('1. The agent can now be answered');
    const first = await request(A.orgId, 'send');
    const list = await fetch(`${BASE}/api/approvals`, { headers: { Cookie: A.cookie } });
    const listBody = await list.json().catch(() => ({}));
    (listBody.pending || []).some((p) => p.id === first)
      ? ok('a pending request is visible', 'before this, 24 sat unanswerable for 13 days')
      : no('a pending request is visible', JSON.stringify(listBody).slice(0, 150));

    const approved = await decide(A.cookie, first, 'approved');
    approved.status === 200 && approved.body.status === 'approved'
      ? ok('it can be approved')
      : no('it can be approved', JSON.stringify(approved.body).slice(0, 150));

    const dupe = await decide(A.cookie, first, 'approved');
    dupe.status === 409
      ? ok('the same request cannot be decided twice', 'HTTP 409')
      : no('the same request cannot be decided twice', `HTTP ${dupe.status}`);

    // ── 2. A decision survives a timed-out workflow ─────────────────────────
    console.log('\n2. A decision made late is still a decision');
    const stale = await request(A.orgId, 'send', 'workflow-that-finished-long-ago');
    const late = await decide(A.cookie, stale, 'approved');
    late.status === 200 && late.body.signalled === false
      ? ok('recorded even though the workflow had gone', late.body.signalNote || 'no signal')
      : no('recorded even though the workflow had gone', JSON.stringify(late.body).slice(0, 150));

    // ── 3. Rejection demands a reason ──────────────────────────────────────
    console.log('\n3. A rejection has to say why');
    const needsReason = await request(A.orgId, 'send');
    const bare = await decide(A.cookie, needsReason, 'rejected', '');
    bare.status === 400
      ? ok('a bare rejection is refused', 'the reason is the most valuable text here')
      : no('a bare rejection is refused', `HTTP ${bare.status}`);
    const withReason = await decide(A.cookie, needsReason, 'rejected', 'price was wrong');
    withReason.status === 200
      ? ok('a rejection with a reason is accepted')
      : no('a rejection with a reason is accepted', JSON.stringify(withReason.body).slice(0, 120));

    // ── 4. Graduation ──────────────────────────────────────────────────────
    console.log('\n4. Ten approvals in a row earns one level');
    await level(A.orgId, 'send') === 'ask'
      ? ok('it starts at ask', 'the only default')
      : no('it starts at ask', await level(A.orgId, 'send'));

    let promotedAt = null;
    for (let i = 0; i < 10; i++) {
      const id = await request(A.orgId, 'send');
      const r = await decide(A.cookie, id, 'approved');
      if (r.body.promoted) promotedAt = i + 1;
    }
    const sendLevel = await level(A.orgId, 'send');
    sendLevel === 'notify'
      ? ok('send graduated to notify', `after ${promotedAt} approvals`)
      : no('send graduated to notify', `level=${sendLevel}`);

    // ── 5. One rejection undoes it ─────────────────────────────────────────
    console.log('\n5. One rejection costs all of it');
    const undo = await request(A.orgId, 'send');
    await decide(A.cookie, undo, 'rejected', 'wrong tone for this customer');
    const afterReject = await level(A.orgId, 'send');
    afterReject === 'ask'
      ? ok('it drops all the way back to ask', 'a person stopping the agent is the strongest signal there is')
      : no('it drops all the way back to ask', `level=${afterReject}`);

    const streak = await db.query(
      `SELECT consecutive_approvals FROM org_action_autonomy
        WHERE org_id = $1 AND action_class = 'send'`, [A.orgId]);
    streak.rows[0].consecutive_approvals === 0
      ? ok('the streak resets', 'a run interrupted by a no is not a run')
      : no('the streak resets', `${streak.rows[0].consecutive_approvals}`);

    // ── 6. What must NEVER graduate ────────────────────────────────────────
    console.log('\n6. Money and contracts never stop asking');
    for (const cls of ['pay', 'sign', 'legal']) {
      for (let i = 0; i < 12; i++) {
        const id = await request(A.orgId, cls);
        await decide(A.cookie, id, 'approved');
      }
      const l = await level(A.orgId, cls);
      l === 'ask'
        ? ok(`${cls} is still asking after 12 approvals`, 'a hard allowlist, not a setting')
        : no(`${cls} is still asking after 12 approvals`, `level=${l}`);
    }
    const mayNot = await db.query(
      `SELECT action_class_may_graduate('pay') AS pay,
              action_class_may_graduate('send') AS send`);
    mayNot.rows[0].pay === false && mayNot.rows[0].send === true
      ? ok('the allowlist is explicit', 'send may, pay never')
      : no('the allowlist is explicit', JSON.stringify(mayNot.rows[0]));

    // ── 7. The panic button ────────────────────────────────────────────────
    console.log('\n7. Everything can be revoked in one call');
    for (let i = 0; i < 10; i++) {
      const id = await request(A.orgId, 'publish');
      await decide(A.cookie, id, 'approved');
    }
    await level(A.orgId, 'publish') === 'notify'
      ? ok('publish graduated first', 'so there is something to revoke')
      : no('publish graduated first', await level(A.orgId, 'publish'));

    const revoked = await db.query(`SELECT revoke_all_autonomy($1::uuid, NULL) AS n`, [A.orgId]);
    Number(revoked.rows[0].n) >= 1 && await level(A.orgId, 'publish') === 'ask'
      ? ok('one call puts everything back to ask', `${revoked.rows[0].n} class(es) revoked`)
      : no('one call puts everything back to ask', `${revoked.rows[0].n}`);

    // ── 8. Isolation ───────────────────────────────────────────────────────
    console.log("\n8. One tenant's trust is not another's");
    for (let i = 0; i < 10; i++) {
      const id = await request(B.orgId, 'send');
      await decide(B.cookie, id, 'approved');
    }
    await level(B.orgId, 'send') === 'notify' && await level(A.orgId, 'send') === 'ask'
      ? ok('B earned trust and A did not inherit it')
      : no('B earned trust and A did not inherit it',
        `B=${await level(B.orgId, 'send')} A=${await level(A.orgId, 'send')}`);

    const crossOrg = await request(B.orgId, 'send');
    const stolen = await decide(A.cookie, crossOrg, 'approved');
    stolen.status === 409 || stolen.status === 404
      ? ok("A cannot decide B's approval", `HTTP ${stolen.status}`)
      : no("A cannot decide B's approval", `HTTP ${stolen.status} — CROSS-TENANT`);

    const unauth = await fetch(`${BASE}/api/approvals`, {});
    unauth.status === 401
      ? ok('the approvals list needs a session', 'HTTP 401')
      : no('the approvals list needs a session', `HTTP ${unauth.status}`);
  } finally {
    await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[A.orgId, B.orgId]]);
    await db.end();
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
