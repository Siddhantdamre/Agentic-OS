#!/usr/bin/env node
'use strict';
/**
 * MONEY METRICS, END TO END — is the revenue figure defensible?
 *
 * The arithmetic has 15 unit tests. What those cannot cover is everything that
 * only exists once a database and an HTTP layer are involved, and this is the
 * number a business will quote back at renewal — so the failures that matter
 * are the flattering ones:
 *
 *   - counting revenue from a conversation a person actually handled
 *   - counting the same payment twice because a webhook retried
 *   - adding rupees to dollars and printing a total
 *   - showing money from another tenant
 *   - reporting a figure nobody can trace back to a record
 *
 * Every case below is one of those. No payment provider is involved: outcomes
 * are recorded through the same door a Razorpay or Stripe webhook would use.
 *
 * Usage: node infra/scripts/check-money-metrics.js
 * Exit:  0 = the number is defensible, 1 = it is not
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
const money = (n) => new Intl.NumberFormat('en-IN').format(n);

/** A conversation, optionally with a person involved, aged into the past. */
async function conversation(orgId, { humanTouched = false, daysAgo = 3 } = {}) {
  const c = await db.query(
    `INSERT INTO conversations (org_id, contact_id, status, started_at)
     VALUES ($1, $2, 'open', NOW() - ($3 || ' days')::interval) RETURNING id`,
    [orgId, `money-${stamp}-${seq++}`, String(daysAgo)],
  );
  const id = c.rows[0].id;
  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
     VALUES ($1, $2, 'assistant', 'answered', NOW() - ($3 || ' days')::interval)`,
    [orgId, id, String(daysAgo)],
  );
  if (humanTouched) {
    await db.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
       VALUES ($1, $2, 'human_agent', 'stepped in', NOW() - ($3 || ' days')::interval)`,
      [orgId, id, String(daysAgo)],
    );
  }
  return id;
}

/** Record through the database door — the same one a PSP webhook would use. */
async function record(orgId, convId, kind, amount, currency, sourceId, daysAgo = 3) {
  const r = await db.query(
    `SELECT record_value_outcome($1::uuid, $2::uuid, $3::text, $4::numeric, $5::text,
                                  'test', $6::text,
                                  NOW() - ($7 || ' days')::interval) AS id`,
    [orgId, convId, kind, amount, currency, sourceId, String(daysAgo)],
  );
  return r.rows[0].id;
}

async function impact(cookie, days = 30) {
  const res = await fetch(`${BASE}/api/impact?days=${days}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  await db.connect();
  console.log('\n=== MONEY METRICS — IS THE NUMBER DEFENSIBLE? ===\n');

  // Two real tenants through the real signup, so the session cookies are real.
  const mk = async (tag) => {
    const email = `money-${tag}-${stamp}@example.com`;
    const r = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: `Money!${stamp}aA1` }),
    });
    const b = await r.json().catch(() => ({}));
    const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    return { orgId: b.orgId, cookie };
  };

  console.log('1. Two tenants, several weeks, several currencies');
  const A = await mk('a');
  const B = await mk('b');
  if (!A.orgId || !B.orgId) throw new Error('could not register the test tenants');

  try {
    // ── Org A, inside the window ────────────────────────────────────────────
    // AI alone: ₹3,00,000 + ₹1,20,000 = ₹4,20,000
    await record(A.orgId, await conversation(A.orgId), 'deal_closed', 300000, 'INR', `a-deal-1-${stamp}`);
    await record(A.orgId, await conversation(A.orgId), 'payment_received', 120000, 'INR', `a-pay-1-${stamp}`);
    // A person handled this one: ₹80,000 must NOT be credited to the AI.
    await record(A.orgId, await conversation(A.orgId, { humanTouched: true }),
      'payment_received', 80000, 'INR', `a-pay-2-${stamp}`);
    // A different currency, which must never be added to the rupees.
    await record(A.orgId, await conversation(A.orgId), 'deal_closed', 5000, 'USD', `a-deal-usd-${stamp}`);
    // Meetings carry no money: countable, not revenue.
    await record(A.orgId, await conversation(A.orgId), 'meeting_booked', null, null, `a-meet-1-${stamp}`);
    await record(A.orgId, await conversation(A.orgId), 'meeting_booked', null, null, `a-meet-2-${stamp}`);
    // OUTSIDE the 30-day window — must not appear.
    await record(A.orgId, await conversation(A.orgId, { daysAgo: 60 }),
      'deal_closed', 999999, 'INR', `a-old-${stamp}`, 60);

    // ── Org B ───────────────────────────────────────────────────────────────
    await record(B.orgId, await conversation(B.orgId), 'payment_received', 77777, 'INR', `b-pay-${stamp}`);
    ok('seeded', 'A: 2 currencies, an old row, 2 meetings · B: its own payment');

    // ── The split ───────────────────────────────────────────────────────────
    console.log('\n2. Revenue is split by whether a person was involved');
    const a = await impact(A.cookie);
    a.status === 200 ? ok('impact answers') : no('impact answers', `HTTP ${a.status}`);

    const inr = (a.body.money?.byCurrency || []).find((c) => c.currency === 'INR');
    const usd = (a.body.money?.byCurrency || []).find((c) => c.currency === 'USD');

    inr?.withoutHuman === 420000
      ? ok('AI-only value is right', `₹${money(420000)}`)
      : no('AI-only value is right', `got ${inr?.withoutHuman}`);
    inr?.withHuman === 80000
      ? ok('value on a human-handled conversation is separated', `₹${money(80000)}`)
      : no('value on a human-handled conversation is separated', `got ${inr?.withHuman}`);
    inr?.autonomousPct === 84
      ? ok('the autonomous share is per currency', '84% of ₹5,00,000')
      : no('the autonomous share is per currency', `got ${inr?.autonomousPct}`);

    console.log('\n3. Currencies are never added together');
    usd?.total === 5000
      ? ok('the dollar row stands on its own', '$5,000')
      : no('the dollar row stands on its own', `got ${usd?.total}`);
    !(a.body.money?.byCurrency || []).some((c) => c.total === 505000)
      ? ok('nothing anywhere equals rupees plus dollars', 'a cross-currency total means nothing')
      : no('nothing anywhere equals rupees plus dollars', 'CURRENCIES WERE SUMMED');

    console.log('\n4. Counts and money are different things');
    a.body.money?.counts?.meetingsBooked === 2
      ? ok('meetings are counted', '2')
      : no('meetings are counted', `${a.body.money?.counts?.meetingsBooked}`);
    a.body.money?.counts?.withoutAmount === 2
      ? ok('outcomes with no amount are reported, not hidden', '2 meetings carried no figure')
      : no('outcomes with no amount are reported', `${a.body.money?.counts?.withoutAmount}`);
    a.body.money?.counts?.paymentsReceived === 2 && a.body.money?.counts?.dealsClosed === 2
      ? ok('payments and deals are counted separately', '2 and 2')
      : no('payments and deals are counted separately',
        `${a.body.money?.counts?.paymentsReceived}/${a.body.money?.counts?.dealsClosed}`);

    console.log('\n5. The window is respected');
    inr?.total === 500000
      ? ok('a 60-day-old deal is outside the 30-day window', 'the ₹9,99,999 row is excluded')
      : no('a 60-day-old deal is outside the 30-day window', `total ${inr?.total}`);
    const wide = await impact(A.cookie, 90);
    (wide.body.money?.byCurrency || []).find((c) => c.currency === 'INR')?.total === 1499999
      ? ok('widening the window brings it back', 'proof it was excluded, not lost')
      : no('widening the window brings it back',
        `${(wide.body.money?.byCurrency || []).find((c) => c.currency === 'INR')?.total}`);

    console.log('\n6. One tenant never sees another tenant\'s money');
    const b = await impact(B.cookie);
    const bInr = (b.body.money?.byCurrency || []).find((c) => c.currency === 'INR');
    bInr?.total === 77777
      ? ok('B sees only its own revenue', `₹${money(77777)}`)
      : no('B sees only its own revenue', `got ${bInr?.total}`);
    !(b.body.money?.byCurrency || []).some((c) => c.currency === 'USD')
      ? ok("B has no sight of A's dollars")
      : no("B has no sight of A's dollars", 'CROSS-TENANT LEAK');

    console.log('\n7. A retrying webhook cannot double-count revenue');
    for (let i = 0; i < 3; i++) {
      await record(B.orgId, null, 'payment_received', 77777, 'INR', `b-pay-${stamp}`);
    }
    const bAgain = await impact(B.cookie);
    (bAgain.body.money?.byCurrency || []).find((c) => c.currency === 'INR')?.total === 77777
      ? ok('three replays of the same payment stay one payment', 'inflated revenue is the error a customer finds')
      : no('three replays of the same payment stay one payment',
        `${(bAgain.body.money?.byCurrency || []).find((c) => c.currency === 'INR')?.total}`);

    console.log('\n8. The door refuses what it cannot defend');
    const bad = async (body) => {
      const r = await fetch(`${BASE}/api/outcomes/value`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: A.cookie },
        body: JSON.stringify(body),
      });
      return r.status;
    };
    await bad({ kind: 'payment_received', amount: 500, sourceId: `x-${stamp}` }) === 400
      ? ok('an amount with no currency is refused', '"500" of what?')
      : no('an amount with no currency is refused');
    await bad({ kind: 'payment_received', currency: 'INR', sourceId: `y-${stamp}` }) === 400
      ? ok('a payment with no amount is refused')
      : no('a payment with no amount is refused');
    await bad({ kind: 'deal_closed', amount: 100, currency: 'INR' }) === 400
      ? ok('an outcome with no source is refused', 'an untraceable figure is worse than none')
      : no('an outcome with no source is refused');
    await bad({ kind: 'vibes', sourceId: `z-${stamp}` }) === 400
      ? ok('an unknown outcome kind is refused')
      : no('an unknown outcome kind is refused');

    const unauth = await fetch(`${BASE}/api/outcomes/value`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'deal_closed', sourceId: 'nope' }),
    });
    unauth.status === 401
      ? ok('recording revenue requires a session', 'HTTP 401')
      : no('recording revenue requires a session', `HTTP ${unauth.status}`);

    console.log('\n9. No causal claim is made');
    a.body.causal?.comparisonAvailable === false
      ? ok('it reports having no control group', 'so the money is correlation, and says so')
      : no('it reports having no control group');

    // ── The summary a business would read ───────────────────────────────────
    console.log('\n─── SAMPLE SUMMARY (org A, last 30 days) ───\n');
    for (const c of a.body.money.byCurrency) {
      const fmt = new Intl.NumberFormat(c.currency === 'INR' ? 'en-IN' : 'en-US',
        { style: 'currency', currency: c.currency, maximumFractionDigits: 0 });
      console.log(`  ${fmt.format(c.withoutHuman)} handled with nobody stepping in`
        + `  (${c.autonomousPct}% of ${fmt.format(c.total)})`);
    }
    const k = a.body.money.counts;
    console.log(`  ${k.meetingsBooked} meetings booked · ${k.paymentsReceived} payments received`
      + ` · ${k.dealsClosed} deals closed`);
    console.log(`  ${k.withoutAmount} outcome(s) carried no amount and are excluded from the value above`);
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
