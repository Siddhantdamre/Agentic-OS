#!/usr/bin/env node
'use strict';
/**
 * QUIET LEADS — does the agent act first, and does it know when not to?
 *
 * This is the first feature where the agent contacts someone nobody asked it
 * to contact. Every other suite in this repo checks that an answer was good.
 * This one checks that a message was NOT sent — which is the failure that
 * costs a customer their reputation rather than one conversation.
 *
 * The decision rules themselves are unit-tested in
 * services/workflows/src/leads/quiet.ts. What is checked HERE is everything
 * that only breaks once a database is involved: the opt-in gates, the ledger,
 * the cooldown, tenant isolation, and the two defects found while building it,
 * both of which passed every unit test and were only visible end to end.
 *
 * Usage: node infra/scripts/check-quiet-leads.js
 * Exit:  0 = the agent acts and restrains itself correctly, 1 = it does not
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
const app = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const stamp = Date.now();

function seed(mode) {
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'seed-quiet-leads-demo.js'), '--mode', mode],
    { encoding: 'utf8', env: process.env, timeout: 120000 });
  const id = String(r.stdout || '').trim().split('\n').pop();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`seed failed: ${r.stdout} ${r.stderr}`);
  return id;
}

function run(orgId, extra = []) {
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'quiet-leads.js'), '--org', orgId, ...extra],
    { encoding: 'utf8', env: process.env, timeout: 180000 });
  return String(r.stdout || '') + String(r.stderr || '');
}

const countOf = async (orgId, where) =>
  Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM lead_followups WHERE org_id=$1 AND ${where}`, [orgId])).rows[0].n);

const sentMessages = async (orgId) =>
  Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM messages m
      WHERE m.org_id=$1 AND m.role='assistant' AND m.content LIKE 'Hello —%'`, [orgId])).rows[0].n);

(async () => {
  await db.connect();
  await app.connect();
  console.log('\n=== QUIET LEADS — DOES IT ACT, AND DOES IT KNOW WHEN NOT TO? ===\n');

  const orgs = [];
  try {
    // ── 1. Opt in twice, or nothing happens ─────────────────────────────────
    console.log('1. Nothing is sent without two deliberate decisions');
    const offOrg = seed('off'); orgs.push(offOrg);
    run(offOrg, ['--send']);
    (await countOf(offOrg, 'TRUE')) === 0 && (await sentMessages(offOrg)) === 0
      ? ok('mode=off sends nothing and records nothing', 'installing the feature is not enabling it')
      : no('mode=off sends nothing', `${await countOf(offOrg, 'TRUE')} row(s)`);

    const dryOrg = seed('dry_run'); orgs.push(dryOrg);
    run(dryOrg, ['--send']);
    (await sentMessages(dryOrg)) === 0 && (await countOf(dryOrg, "status='suppressed'")) === 2
      ? ok('mode=dry_run drafts and suppresses', '2 drafted, 0 sent — you can watch before trusting')
      : no('mode=dry_run drafts and suppresses',
        `sent=${await sentMessages(dryOrg)} suppressed=${await countOf(dryOrg, "status='suppressed'")}`);

    const onOrg = seed('on'); orgs.push(onOrg);
    run(onOrg);   // mode=on but NO --send
    (await sentMessages(onOrg)) === 0 && (await countOf(onOrg, "status='proposed'")) === 2
      ? ok('mode=on WITHOUT --send still sends nothing', 'both gates are required')
      : no('mode=on without --send sends nothing', `${await sentMessages(onOrg)} message(s) went out`);

    // ── 2. It acts ──────────────────────────────────────────────────────────
    console.log('\n2. Armed, it does the work nobody asked for');
    const out = run(onOrg, ['--send']);
    const sent = await sentMessages(onOrg);
    sent === 2
      ? ok('it contacted the 2 leads worth contacting', 'unprompted — no inbound message triggered this')
      : no('it contacted the 2 leads worth contacting', `${sent} sent`);

    const kinds = await db.query(
      `SELECT action_kind, COUNT(*)::int AS n FROM agent_actions WHERE org_id=$1 GROUP BY 1`, [onOrg]);
    const followups = kinds.rows.find((k) => k.action_kind === 'followup_sent');
    followups && followups.n === 2
      ? ok('recorded as followup_sent, not reply_sent',
        'otherwise the first work the agent ever started is invisible in its own ledger')
      : no('recorded as followup_sent', JSON.stringify(kinds.rows));

    // ── 3. The six it must leave alone ──────────────────────────────────────
    console.log('\n3. The six it must leave alone, each for its own reason');
    for (const reason of ['customer_declined', 'complaint', 'awaiting_us', 'too_old', 'not_quiet_yet', 'resolved']) {
      new RegExp(`${reason}=1`).test(out)
        ? ok(`left alone: ${reason}`)
        : no(`left alone: ${reason}`, 'this lead should not have been contacted');
    }
    // The two that would be actively damaging get a durable row, not just a
    // counter — an operator must be able to prove the complaint was spared.
    (await countOf(onOrg, "status='skipped' AND skip_reason='complaint'")) === 1
      ? ok('the complaint is recorded as deliberately spared', 'provable, not merely absent')
      : no('the complaint is recorded as deliberately spared');
    (await countOf(onOrg, "status='skipped' AND skip_reason='customer_declined'")) === 1
      ? ok('so is the person who said no')
      : no('so is the person who said no');

    // ── 4. REGRESSION: the cooldown ─────────────────────────────────────────
    console.log('\n4. REGRESSION — running again must not nudge the same people');
    // Found end to end: record_lead_followup stamped sent_at only on INSERT,
    // so a proposed row promoted to sent kept a NULL timestamp, the cooldown
    // read MAX(sent_at) as NULL, and the same lead was nudged again minutes
    // later, escalating through nudge 2 and 3.
    const again = run(onOrg, ['--send']);
    (await sentMessages(onOrg)) === 2
      ? ok('a second run sends nothing', 'two is a follow-up, three is harassment')
      : no('a second run sends nothing', `${await sentMessages(onOrg)} messages now exist`);
    /cooling_off=2/.test(again)
      ? ok('and says why', 'cooling_off=2')
      : no('and says why', 'the cooldown reason is missing');
    (await countOf(onOrg, "status='sent' AND sent_at IS NULL")) === 0
      ? ok('every sent row carries a timestamp', 'a NULL sent_at silently disables BOTH the cooldown and the outcome')
      : no('every sent row carries a timestamp', 'sent_at is NULL on a sent row');

    // ── 5. REGRESSION: the ledger cannot lie ────────────────────────────────
    console.log('\n5. REGRESSION — the ledger never claims a message that does not exist');
    const claimed = await countOf(onOrg, "status='sent'");
    const actual = await sentMessages(onOrg);
    claimed === actual
      ? ok(`${claimed} claimed, ${actual} actually in the conversation`,
        'the send is one transaction; a failure rolls the claim back too')
      : no('the ledger matches reality', `claimed ${claimed}, actual ${actual}`);

    // ── 6. Did it work? ─────────────────────────────────────────────────────
    console.log('\n6. The outcome is measured, and cannot flatter itself');
    await db.query(
      `INSERT INTO messages (org_id, conversation_id, role, content)
       SELECT org_id, conversation_id, 'user', 'Yes, still interested.'
         FROM lead_followups WHERE org_id=$1 AND status='sent' ORDER BY sent_at LIMIT 1`, [onOrg]);
    const settled = run(onOrg, ['--settle']);
    /1 of 2 people replied/.test(settled)
      ? ok('a reply after the nudge is counted', '1 of 2')
      : no('a reply after the nudge is counted', settled.split('\n').filter(Boolean).pop());
    /Too few to quote a rate/.test(settled)
      ? ok('but no percentage is quoted from 2 data points', 'a rate from a handful is theatre')
      : no('but no percentage is quoted from 2 data points');

    // A message that predates the nudge must never be credited to it.
    const preExisting = await db.query(
      `SELECT COUNT(*)::int AS n FROM lead_followups
        WHERE org_id=$1 AND replied_at IS NOT NULL AND replied_at <= sent_at`, [onOrg]);
    preExisting.rows[0].n === 0
      ? ok('no follow-up takes credit for a reply that predates it')
      : no('no follow-up takes credit for a reply that predates it', `${preExisting.rows[0].n} row(s)`);

    // ── 7. Isolation ────────────────────────────────────────────────────────
    console.log('\n7. One workspace cannot see another\'s follow-ups');
    await app.query("SELECT set_config('app.current_org_id', $1, false)", [dryOrg]);
    const cross = await app.query(
      `SELECT COUNT(*)::int AS n FROM lead_followups WHERE org_id = $1`, [onOrg]);
    cross.rows[0].n === 0
      ? ok('reading another workspace\'s follow-ups returns nothing', 'asserted as darex_app under RLS')
      : no('reading another workspace\'s follow-ups returns nothing', `${cross.rows[0].n} row(s) leaked`);

    let refused = false;
    try {
      await db.query(
        `SELECT record_lead_followup($1::uuid, (SELECT id FROM conversations WHERE org_id=$2 LIMIT 1),
                                     NULL, 1, 5, 'sent', NULL, 'x')`, [dryOrg, onOrg]);
    } catch { refused = true; }
    refused
      ? ok('recording a follow-up against another workspace is refused')
      : no('recording a follow-up against another workspace is refused', 'IT WROTE ACROSS TENANTS');
  } finally {
    if (orgs.length) {
      await db.query('DELETE FROM orgs WHERE id = ANY($1::uuid[])', [orgs]).catch(() => {});
    }
    await db.end().catch(() => {});
    await app.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  try { await app.end(); } catch { /* closed */ }
  process.exit(1);
});
