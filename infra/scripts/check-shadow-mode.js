#!/usr/bin/env node
'use strict';
/**
 * SHADOW MODE — is the agreement number honest?
 *
 * This is the number a business will look at when deciding whether to let the
 * agent act unsupervised. So the failures that matter are the FLATTERING ones:
 *
 *   - a substantive edit scored as agreement
 *   - a percentage shown over four data points
 *   - one tenant's agreement rate including another tenant's decisions
 *   - the disagreements hidden behind a good headline
 *   - the wording drifting from "agreed with you" toward "was right"
 *
 * That last one is not pedantry. The human is ground truth for what THIS
 * business would have done, not for what is correct — an agent agreeing
 * perfectly with a mistaken operator is agreeing perfectly and performing
 * badly. If the label ever says "accuracy", the number becomes a lie the
 * moment somebody quotes it.
 *
 * Usage: node infra/scripts/check-shadow-mode.js
 * Exit:  0 = the number is honest, 1 = it is not
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

/** An operator sent something after the agent drafted something. */
async function edit(orgId, draft, sent) {
  await db.query(
    `INSERT INTO reply_edits (org_id, question, ai_draft, operator_final, learned)
     VALUES ($1, $2, $3, $4, false)`,
    [orgId, `q-${seq++}`, draft, sent],
  );
}

/** The agent asked to act and a human answered. */
async function approval(orgId, decision, reason = null) {
  const wi = (await db.query(
    `INSERT INTO work_items (org_id, type, status, channel)
     VALUES ($1, 'conversation', 'waiting_approval', 'inbox') RETURNING id`, [orgId])).rows[0].id;
  const id = (await db.query(
    `SELECT record_approval_request($1::uuid, $2::uuid, NULL, 'send',
                                     $3::text, 'draft text', NULL) AS id`,
    [orgId, wi, `wants to send (#${seq++})`])).rows[0].id;
  await db.query(
    `UPDATE approval_requests SET status = $3, decided_at = NOW(), reason = $4
      WHERE id = $1 AND org_id = $2`,
    [id, orgId, decision, reason]);
}

async function shadow(cookie, days = 30) {
  const res = await fetch(`${BASE}/api/shadow?days=${days}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  await db.connect();
  console.log('\n=== SHADOW MODE — IS THE AGREEMENT NUMBER HONEST? ===\n');

  const mk = async (tag) => {
    const email = `shadow-${tag}-${stamp}@example.com`;
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: `Shadow!${stamp}aA1` }),
    });
    const b = await r.json().catch(() => ({}));
    const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    return { orgId: b.orgId, cookie };
  };

  const A = await mk('a');
  const B = await mk('b');
  if (!A.orgId || !B.orgId) throw new Error('could not register test tenants');

  try {
    // ── 1. Too little evidence ──────────────────────────────────────────────
    console.log('1. A small sample gets no percentage');
    for (let i = 0; i < 4; i++) await edit(A.orgId, 'We open at 9am.', 'We open at 9am.');
    let s = await shadow(A.cookie);
    s.body.agreementPct === null && s.body.decided === 4
      ? ok('4 decisions produce counts, not a rate', '"3 of 4" is not 75% for any decision')
      : no('4 decisions produce counts, not a rate', `pct=${s.body.agreementPct} n=${s.body.decided}`);
    /Too few/.test(s.body.headline || '')
      ? ok('and it says why in words')
      : no('and it says why in words', s.body.headline);

    // ── 2. What counts, and what does not ───────────────────────────────────
    console.log('\n2. A tidy-up is agreement; a changed fact is not');
    // 6 more identical -> 10 total identical
    for (let i = 0; i < 6; i++) await edit(A.orgId, 'We open at 9am.', 'We open at 9am.');
    // 2 cosmetic
    await edit(A.orgId, 'We open  at 9am.', 'We open at 9am');
    await edit(A.orgId, 'It costs 5,000.', 'It costs 5,000');
    // 1 substantive: a single word, and the most important kind of correction
    await edit(A.orgId, 'Returns are within 30 days.', 'Returns are within 45 days.');

    s = await shadow(A.cookie);
    s.body.agreed === 10 && s.body.cosmetic === 2 && s.body.disagreed === 1
      ? ok('10 sent as written, 2 tidied, 1 changed', 'the one-word change counts as disagreement')
      : no('10 sent as written, 2 tidied, 1 changed',
        `agreed=${s.body.agreed} cosmetic=${s.body.cosmetic} disagreed=${s.body.disagreed}`);
    s.body.agreementPct === 92.3
      ? ok('the rate is 12 of 13', '92.3%')
      : no('the rate is 12 of 13', `${s.body.agreementPct}`);

    // ── 3. The disagreements are surfaced ───────────────────────────────────
    console.log('\n3. The cases it got wrong are shown, not hidden');
    (s.body.disagreements || []).some((d) => /45 days/.test(d.humanOutcome || ''))
      ? ok('the changed reply is in the list', 'a dashboard that hides the 8% is a brochure')
      : no('the changed reply is in the list', JSON.stringify(s.body.disagreements).slice(0, 150));
    (s.body.disagreements || []).every((d) => d.proposed && d.humanOutcome)
      ? ok('each shows what it proposed AND what you did')
      : no('each shows what it proposed AND what you did');

    // ── 4. Approvals count too, and separately ──────────────────────────────
    console.log('\n4. Actions and replies are different kinds of trust');
    await approval(A.orgId, 'approved');
    await approval(A.orgId, 'approved');
    await approval(A.orgId, 'rejected', 'wrong customer');
    s = await shadow(A.cookie);
    s.body.bySource?.approval?.decided === 3 && s.body.bySource?.approval?.agreed === 2
      ? ok('approvals are tracked on their own axis', '2 of 3')
      : no('approvals are tracked on their own axis', JSON.stringify(s.body.bySource));
    s.body.bySource?.reply?.decided === 13
      ? ok('replies stay on theirs', '13')
      : no('replies stay on theirs', `${s.body.bySource?.reply?.decided}`);
    (s.body.disagreements || []).some((d) => d.reason === 'wrong customer')
      ? ok('a rejection carries the reason the human gave', 'the most valuable text collected')
      : no('a rejection carries the reason the human gave');

    // ── 5. The wording ──────────────────────────────────────────────────────
    console.log('\n5. It claims agreement, never correctness');
    /would have done the same thing/.test(s.body.headline || '')
      ? ok('the headline says "would have done the same"')
      : no('the headline says "would have done the same"', s.body.headline);
    !/accura|correct|right\b/i.test(s.body.headline || '')
      ? ok('it never claims accuracy', 'the human is not ground truth for correct')
      : no('it never claims accuracy', s.body.headline);

    // ── 6. Isolation ────────────────────────────────────────────────────────
    console.log('\n6. One tenant\'s judgement is not another\'s');
    for (let i = 0; i < 12; i++) await edit(B.orgId, 'B text.', 'COMPLETELY DIFFERENT');
    const bs = await shadow(B.cookie);
    bs.body.agreementPct === 0 && bs.body.decided === 12
      ? ok('B is measured only on B', '0% of 12, honestly')
      : no('B is measured only on B', `pct=${bs.body.agreementPct} n=${bs.body.decided}`);
    const aAfter = await shadow(A.cookie);
    aAfter.body.decided === 16
      ? ok("A's number is unmoved by B's decisions", '16')
      : no("A's number is unmoved by B's decisions", `${aAfter.body.decided}`);

    // ── 7. The switch ───────────────────────────────────────────────────────
    console.log('\n7. Watching can be turned on and off');
    const on = await fetch(`${BASE}/api/shadow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: A.cookie },
      body: JSON.stringify({ enabled: true }),
    });
    const onBody = await on.json();
    onBody.enabled === true && onBody.startedAt
      ? ok('shadow mode turns on and stamps a start time')
      : no('shadow mode turns on and stamps a start time', JSON.stringify(onBody));

    const scoped = await shadow(A.cookie);
    scoped.body.shadowMode?.enabled === true && scoped.body.periodDays === null
      ? ok('while on, the rate is scoped to the run', 'not a rolling window that mixes periods')
      : no('while on, the rate is scoped to the run', JSON.stringify(scoped.body.shadowMode));
    scoped.body.decided === 0
      ? ok('the run starts with a clean slate', 'evidence from before you were watching is not this run')
      : no('the run starts with a clean slate', `${scoped.body.decided}`);

    await fetch(`${BASE}/api/shadow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: A.cookie },
      body: JSON.stringify({ enabled: false }),
    });
    const off = await shadow(A.cookie);
    off.body.shadowMode?.enabled === false && off.body.decided === 16
      ? ok('turning it off returns to the rolling window', '16 again')
      : no('turning it off returns to the rolling window',
        `enabled=${off.body.shadowMode?.enabled} n=${off.body.decided}`);

    const unauth = await fetch(`${BASE}/api/shadow`);
    unauth.status === 401
      ? ok('it needs a session', 'HTTP 401')
      : no('it needs a session', `HTTP ${unauth.status}`);

    console.log('\n─── SAMPLE HEADLINE ───\n');
    console.log(`  ${off.body.headline}`);
    console.log(`  ${off.body.disagreed} disagreement(s) shown, newest first.\n`);
  } finally {
    await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[A.orgId, B.orgId]]);
    await db.end();
  }

  console.log(`  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
