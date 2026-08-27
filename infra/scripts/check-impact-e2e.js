#!/usr/bin/env node
'use strict';
/**
 * THE VALUE STORY, END TO END — is the number a business would renew on true?
 *
 * The outcome ledger was built, unit-tested, and never run or read. Closing
 * that gap means three things now have to be right together: conversations get
 * closed, the closure records whether a human was involved, and the API turns
 * that into a rate nobody has to take on faith.
 *
 * This asserts the arithmetic against conversations it constructs itself, so
 * every expected number is known in advance rather than read back from the
 * thing under test. It also pins the two ways this measurement could lie:
 *
 *   - closing a needs_attention thread, which turns an unmet obligation into
 *     a success metric
 *   - counting a thread the agent never touched, which drags the rate toward
 *     whatever the humans happened to be doing
 *
 * Usage: node infra/scripts/check-impact-e2e.js
 * Exit:  0 = the numbers are honest, 1 = they are not
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
const email = `impact-${stamp}@example.com`;
const password = `Impact!${stamp}aA1`;

/** Build a conversation with a scripted transcript, aged into the past. */
async function seed(orgId, { roles, hoursAgo, status = 'open' }) {
  const conv = await db.query(
    `INSERT INTO conversations (org_id, contact_id, status, started_at)
     VALUES ($1, $2, $3, NOW() - ($4 || ' hours')::interval) RETURNING id`,
    [orgId, `c-${stamp}-${Math.random().toString(36).slice(2, 8)}`, status, String(hoursAgo + 1)],
  );
  const id = conv.rows[0].id;
  let offset = hoursAgo + 1;
  for (const role of roles) {
    await db.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, NOW() - ($5 || ' hours')::interval)`,
      [orgId, id, role, `${role} message`, String(offset)],
    );
    offset -= 0.1;
  }
  return id;
}

(async () => {
  await db.connect();
  console.log('\n=== IMPACT / OUTCOME LEDGER END-TO-END ===\n');

  console.log('1. A tenant and a session');
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const regBody = await reg.json().catch(() => ({}));
  const orgId = regBody.orgId;
  orgId ? ok('tenant registered', `${String(orgId).slice(0, 8)}…`)
    : no('tenant registered', `HTTP ${reg.status} ${JSON.stringify(regBody).slice(0, 120)}`);
  if (!orgId) throw new Error('cannot continue without an org');
  const cookie = (reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

  console.log('\n2. Six conversations with known, different endings');
  // Three the agent finished alone.
  for (let i = 0; i < 3; i++) {
    await seed(orgId, { roles: ['user', 'assistant'], hoursAgo: 48 });
  }
  // One where a person had to step in.
  await seed(orgId, { roles: ['user', 'assistant', 'human_agent'], hoursAgo: 48 });
  // One still live — quiet for only an hour.
  await seed(orgId, { roles: ['user', 'assistant'], hoursAgo: 1 });
  // One escalated and old. This is the trap: quiet AND stale, but somebody
  // still owes this customer an answer.
  const escalated = await seed(orgId, {
    roles: ['user', 'assistant'], hoursAgo: 72, status: 'needs_attention',
  });
  ok('seeded', '3 autonomous, 1 with a human, 1 recent, 1 escalated');

  console.log('\n3. The quiet sweep');
  const swept = await db.query(
    `SELECT * FROM close_quiet_conversations($1::uuid, 24)`, [orgId]);
  const s = swept.rows[0] || {};
  Number(s.resolved_autonomous) === 3
    ? ok('3 closed as autonomous', 'the agent answered and nobody came back')
    : no('3 closed as autonomous', `got ${s.resolved_autonomous}`);
  Number(s.resolved_with_human) === 1
    ? ok('1 closed as needing a human')
    : no('1 closed as needing a human', `got ${s.resolved_with_human}`);

  const stillOpen = await db.query(
    `SELECT COUNT(*)::int AS n FROM conversations
      WHERE org_id = $1 AND resolved_at IS NULL`, [orgId]);
  stillOpen.rows[0].n === 2
    ? ok('the recent and the escalated thread stay open', '2 untouched')
    : no('the recent and the escalated thread stay open', `${stillOpen.rows[0].n} open`);

  const esc = await db.query(
    `SELECT status, resolved_at FROM conversations WHERE id = $1`, [escalated]);
  esc.rows[0].resolved_at === null && esc.rows[0].status === 'needs_attention'
    ? ok('an ESCALATED thread is never closed by going quiet', 'an open obligation is not a success')
    : no('an ESCALATED thread is never closed by going quiet', JSON.stringify(esc.rows[0]));

  console.log('\n4. Idempotence — a re-run must change nothing');
  const again = await db.query(
    `SELECT * FROM close_quiet_conversations($1::uuid, 24)`, [orgId]);
  Number(again.rows[0].resolved_autonomous) === 0 && Number(again.rows[0].resolved_with_human) === 0
    ? ok('re-running closes nothing new', 'reported ROI does not depend on cron punctuality')
    : no('re-running closes nothing new', JSON.stringify(again.rows[0]));

  const times = await db.query(
    `SELECT COUNT(*)::int AS n FROM conversations
      WHERE org_id = $1 AND resolved_at IS NOT NULL AND resolved_at > NOW() - INTERVAL '2 hours'`,
    [orgId]);
  times.rows[0].n === 0
    ? ok('resolved_at is the last message time, not the sweep time')
    : no('resolved_at is the last message time, not the sweep time', `${times.rows[0].n} stamped as just now`);

  console.log('\n5. What the API reports');
  const res = await fetch(`${BASE}/api/impact?days=30`, { headers: { Cookie: cookie } });
  const impact = await res.json().catch(() => ({}));

  res.status === 200 ? ok('impact endpoint answers') : no('impact endpoint answers', `HTTP ${res.status}`);

  impact.current?.autonomous === 3 && impact.current?.withHuman === 1
    ? ok('the split is right', '3 autonomous, 1 with a human')
    : no('the split is right', JSON.stringify(impact.current));

  // 3 of 4 CLOSED conversations = 75%. The still-open ones are excluded from
  // the denominator on purpose: counting them would make the rate fall
  // whenever traffic rose.
  impact.current?.autonomousPct === 75
    ? ok('the headline rate is 75%', '3 of 4 finished conversations, open ones excluded')
    : no('the headline rate is 75%', `got ${impact.current?.autonomousPct}`);

  impact.causal?.comparisonAvailable === false
    ? ok('it reports having NO control group', 'so nothing here may claim causation')
    : no('it reports having NO control group', JSON.stringify(impact.causal));

  console.log('\n6. A human takeover is recorded as a negative outcome');
  const ledger = require(path.join(__dirname, '../../services/workflows/dist/activities/outcome-ledger.js'));
  const now = new Date();
  await ledger.runOutcomeLedger({
    orgId,
    since: new Date(now.getTime() - 30 * 86400_000).toISOString(),
    until: new Date(now.getTime() + 60_000).toISOString(),
    holdoutPercent: 0,
    allowWeak: false,
  });
  const took = await db.query(
    `SELECT COUNT(*)::int AS n FROM outcome_events
      WHERE org_id = $1 AND outcome_kind = 'human_took_over'`, [orgId]);
  took.rows[0].n === 1
    ? ok('one takeover recorded', 'the ledger can move in both directions')
    : no('one takeover recorded', `got ${took.rows[0].n}`);

  await db.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  try { await ledger.closeOutcomeLedgerPool(); } catch { /* unused pool */ }
  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
