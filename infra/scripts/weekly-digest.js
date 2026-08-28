#!/usr/bin/env node
'use strict';
/**
 * THE MONDAY EMAIL — the only thing here that goes looking for the customer.
 *
 * WHY
 * Every learning loop in this product is PULL. The gap list, the corrections,
 * the impact panel — all of them need somebody to remember to log in, and
 * nobody logs into a dashboard weekly. A loop nobody looks at accumulates
 * nothing, and accumulation is the whole moat: the agent only becomes hard to
 * replace if this business keeps teaching it.
 *
 * One email a week turns a dashboard into a ritual, and gives the reader
 * exactly one thing to do.
 *
 * PREVIEW BY DEFAULT
 * Sending email is outward-facing and cannot be undone. This prints what it
 * would send, to whom, and stops. `--send` is a deliberate act.
 *
 * Usage:
 *   node infra/scripts/weekly-digest.js                 preview every org
 *   node infra/scripts/weekly-digest.js --org <uuid>    preview one
 *   node infra/scripts/weekly-digest.js --send          actually send
 *   node infra/scripts/weekly-digest.js --self-test     recipient + gating logic
 *
 * Exit: 0 = ran, 1 = could not.
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const args = process.argv.slice(2);
const SEND = args.includes('--send');
const ORG_ARG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

const APP_URL = process.env.APP_BASE_URL || process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';

/**
 * Who gets it.
 *
 * Owners and admins only — a digest reports how the whole business is doing,
 * including where its AI needed a person, and that is not every member's
 * business to receive. Scoped by org_id in the query rather than filtered
 * afterwards, so a bug here cannot mail one tenant's numbers to another's
 * staff. That is the failure mode that would end a customer relationship in
 * one message.
 */
const RECIPIENT_ROLES = ['owner', 'admin'];

/**
 * Deliver one email.
 *
 * Mirrors apps/dashboard/lib/mail.ts, which stays the canonical implementation
 * for the app itself — a Next.js lib module cannot be required from a plain
 * node script, and duplicating twelve lines is cheaper than the indirection of
 * routing this through an authenticated HTTP endpoint just to reuse them.
 *
 * Returns { sent, reason } rather than throwing: one org's mail failing must
 * not stop the other fifty-two from going out.
 */
async function deliver({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Darex <noreply@localhost>';
  if (!apiKey) return { sent: false, reason: 'RESEND_API_KEY not configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: String(err.message || err).slice(0, 120) };
  }
}

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

/** Everything the email needs, for one org, for last week. */
async function gather(orgId, orgName) {
  // Conversations that FINISHED in each window, split by whether a person was
  // involved. The denominator is finished conversations: including still-open
  // ones would make the rate fall whenever the week was busy, which reads as
  // the AI getting worse in exactly the weeks it did the most.
  const week = async (fromDays, toDays) => {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE c.metadata #>> '{resolution,kind}' = 'autonomous')::int AS alone,
         COUNT(*) FILTER (WHERE c.metadata #>> '{resolution,kind}' = 'with_human')::int  AS person
       FROM conversations c
      WHERE c.org_id = $1
        AND c.resolved_at >= NOW() - ($2 || ' days')::interval
        AND c.resolved_at <  NOW() - ($3 || ' days')::interval
        AND EXISTS (SELECT 1 FROM messages m
                     WHERE m.conversation_id = c.id AND m.org_id = c.org_id
                       AND m.role = 'assistant')`,
      [orgId, String(fromDays), String(toDays)],
    );
    return { alone: r.rows[0].alone, person: r.rows[0].person };
  };

  const now = await week(7, 0);
  const prev = await week(14, 7);
  const prevFinished = prev.alone + prev.person;

  const gaps = await db.query(
    `SELECT id::text, question, times_asked
       FROM knowledge_gaps
      WHERE org_id = $1 AND status = 'open'
      ORDER BY times_asked DESC, last_seen_at DESC
      LIMIT 5`,
    [orgId],
  );

  const taught = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM reply_edits
         WHERE org_id = $1 AND learned = true
           AND created_at >= NOW() - INTERVAL '7 days')                AS corrections,
       (SELECT COUNT(*)::int FROM knowledge_gaps
         WHERE org_id = $1 AND status = 'resolved'
           AND resolved_at >= NOW() - INTERVAL '7 days')               AS gaps_answered`,
    [orgId],
  );

  const promises = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('kept','broken'))::int AS due,
       COUNT(*) FILTER (WHERE status = 'kept')::int             AS kept
     FROM commitments
    WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`,
    [orgId],
  );

  const holdout = await db.query(
    `SELECT COUNT(*)::int AS n FROM agent_actions
      WHERE org_id = $1 AND arm = 'holdout'
        AND occurred_at >= NOW() - INTERVAL '7 days'`,
    [orgId],
  );

  return {
    orgName,
    resolvedAlone: now.alone,
    neededPerson: now.person,
    previousPct: prevFinished > 0 ? Math.round((prev.alone / prevFinished) * 100) : null,
    gaps: gaps.rows.map((g) => ({ id: g.id, question: g.question, timesAsked: g.times_asked })),
    corrections: taught.rows[0].corrections,
    gapsAnswered: taught.rows[0].gaps_answered,
    promisesKept: promises.rows[0].kept,
    promisesDue: promises.rows[0].due,
    causalComparisonAvailable: (holdout.rows[0]?.n ?? 0) > 0,
    brainUrl: `${APP_URL.replace(/\/$/, '')}/brain`,
  };
}

// ── Self-test ───────────────────────────────────────────────────────────────
// The content builder has its own 18 unit tests. What is testable here without
// a database is the gating: who receives it, and when nothing is sent at all.
if (args.includes('--self-test')) {
  let pass = 0;
  let fail = 0;
  const check = (label, cond, detail = '') => {
    if (cond) { pass++; console.log(`  [PASS] ${label}`); }
    else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
  };
  console.log('\n### WEEKLY DIGEST — GATING SELF-TEST\n');

  check('only owners and admins receive it',
    RECIPIENT_ROLES.includes('owner') && RECIPIENT_ROLES.includes('admin')
      && !RECIPIENT_ROLES.includes('member'));

  // Preview must be the default. A script that mails fifty-three businesses
  // when run without arguments is one accident away from a very bad morning.
  check('sending requires an explicit --send', SEND === false || args.includes('--send'));

  (async () => {
    const r = await deliver({ to: 'x@example.com', subject: 's', text: 't' });
    check('with no API key it refuses to send and says why',
      r.sent === false && /RESEND_API_KEY/.test(r.reason || ''), JSON.stringify(r));
    console.log(`\n  passed ${pass} / ${pass + fail}\n`);
    process.exit(fail ? 1 : 0);
  })();
  return;
}

(async () => {
  const { buildWeeklyDigest } = require(
    path.join(__dirname, '../../services/workflows/dist/digest/weekly.js'));

  await db.connect();

  const params = [];
  let sql = `SELECT id, name FROM orgs WHERE status = 'active'`;
  if (ORG_ARG) { params.push(ORG_ARG); sql += ` AND id = $${params.length}`; }
  sql += ' ORDER BY name';
  const orgs = (await db.query(sql, params)).rows;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  WEEKLY DIGEST — ${SEND ? 'SENDING' : 'PREVIEW (nothing will be sent)'}`.padEnd(63) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let built = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const org of orgs) {
    const data = await gather(org.id, org.name);
    const digest = buildWeeklyDigest(data);

    if (!digest) {
      // Nothing happened and nothing is waiting. An email reporting zero of
      // everything trains the reader to delete it unopened, and takes the next
      // one that mattered with it.
      skipped++;
      continue;
    }
    built++;

    const recipients = await db.query(
      `SELECT email FROM users
        WHERE org_id = $1 AND role = ANY($2::text[]) AND email <> ''
        ORDER BY email`,
      [org.id, RECIPIENT_ROLES],
    );

    if (!recipients.rows.length) {
      console.log(`  [ -- ]  ${String(org.name).slice(0, 30).padEnd(30)} built, but no owner or admin to send to`);
      continue;
    }

    const to = recipients.rows.map((r) => r.email);
    if (!SEND) {
      console.log(`  [PREV]  ${String(org.name).slice(0, 30).padEnd(30)} -> ${to.join(', ')}`);
      console.log(`          ${digest.subject}`);
      // Show the BODY when previewing one org. A preview that prints only the
      // subject is not a preview — the whole reason to run this before --send
      // is to read what a customer is about to receive. Across all orgs it
      // stays one line each, because fifty-three full emails is not a preview
      // either.
      if (ORG_ARG) {
        console.log('');
        for (const line of digest.text.split('\n')) console.log(`          ${line}`);
        console.log('');
      }
      continue;
    }

    for (const address of to) {
      const res = await deliver({
        to: address,
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
      });
      if (res.sent) { sent++; console.log(`  [SENT]  ${String(org.name).slice(0, 30).padEnd(30)} -> ${address}`); }
      else { failed++; console.log(`  [FAIL]  ${String(org.name).slice(0, 30).padEnd(30)} -> ${address}  ${res.reason}`); }
    }
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`\n  ${orgs.length} org(s) · ${built} digest(s) worth sending · `
    + `${skipped} had nothing to report`
    + (SEND ? ` · ${sent} sent · ${failed} failed` : ' · nothing sent (preview)') + '\n');
  if (!SEND && built > 0) {
    console.log('  Re-run with --send to actually deliver these.\n');
  }

  await db.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
