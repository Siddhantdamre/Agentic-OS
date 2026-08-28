#!/usr/bin/env node
'use strict';
/**
 * THE COMMITMENT LEDGER — does a promise survive the end of the turn?
 *
 * "I'll check and get back to you" used to evaporate the moment the workflow
 * returned. Nothing tracked a follow-up, a deadline or an owner. The customer
 * waited, nothing arrived, and they concluded the business did not care — the
 * most expensive failure this system had, and the only one invisible in every
 * metric, because the conversation looked resolved.
 *
 * The failures that matter here are not "it did not record". They are:
 *
 *   - it counted a pleasantry as a promise, so the trust metric decays for
 *     obligations nobody owes
 *   - it called a promise broken that somebody had already kept, so the
 *     operator learns to ignore the list
 *   - it escalated the same promise every hour
 *   - it punished the business for a customer who stopped needing the answer
 *
 * Every case below is one of those.
 *
 * Usage: node infra/scripts/check-commitments.js
 * Exit:  0 = promises are tracked honestly, 1 = they are not
 */
const path = require('path');
const { spawnSync } = require('child_process');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const gate = require(path.join(__dirname, '../../services/workflows/dist/reply-gate.js'));

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
let n = 0;

/** A conversation with a customer question and the agent's reply. */
async function conversation(orgId, { question, reply, minutesAgo = 0, status = 'open' }) {
  const c = await db.query(
    `INSERT INTO conversations (org_id, contact_id, status, started_at)
     VALUES ($1, $2, $3, NOW() - ($4 || ' minutes')::interval) RETURNING id`,
    [orgId, `cust-${stamp}-${n++}`, status, String(minutesAgo + 1)],
  );
  const id = c.rows[0].id;
  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
     VALUES ($1, $2, 'user', $3, NOW() - ($4 || ' minutes')::interval)`,
    [orgId, id, question, String(minutesAgo + 1)],
  );
  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
     VALUES ($1, $2, 'assistant', $3, NOW() - ($4 || ' minutes')::interval)`,
    [orgId, id, reply, String(minutesAgo)],
  );
  return id;
}

/** Record a promise exactly as the workflow does, but aged into the past. */
async function promise(orgId, convId, { reply, dueMinutesAgo }) {
  const det = gate.detectCommitment(reply);
  if (!det.made) return null;
  const r = await db.query(
    `INSERT INTO commitments
       (org_id, conversation_id, promise, question, due_at, source_message_id, created_at)
     VALUES ($1, $2, $3, 'test question',
             NOW() - ($4 || ' minutes')::interval,
             $5, NOW() - ($6 || ' minutes')::interval)
     RETURNING id`,
    [orgId, convId, det.promise, String(dueMinutesAgo), `src-${stamp}-${n++}`,
      String(dueMinutesAgo + det.dueInMinutes)],
  );
  return r.rows[0].id;
}

(async () => {
  await db.connect();
  console.log('\n=== COMMITMENT LEDGER — DOES A PROMISE SURVIVE THE TURN? ===\n');

  const org = await db.query(
    `INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`Commitment Check ${stamp}`, `commitment-check-${stamp}`],
  );
  const orgId = org.rows[0].id;

  try {
    // ── 1. Detection is not credulous ───────────────────────────────────────
    console.log('1. Only real promises open an obligation');
    gate.detectCommitment('Let me check that and get back to you.').made
      ? ok('a real promise is detected')
      : no('a real promise is detected');
    !gate.detectCommitment('I will be happy to help. We open at 9am.').made
      ? ok('a pleasantry is not a promise', 'or the trust metric decays for nothing')
      : no('a pleasantry is not a promise');
    !gate.detectCommitment('We will need your order number to check that.').made
      ? ok('a request for information is not a promise', 'the ball is with the customer')
      : no('a request for information is not a promise');
    !gate.detectCommitment('We open at 9am and close at 4pm on Saturday.').made
      ? ok('a plain answer is not a promise')
      : no('a plain answer is not a promise');

    const timed = gate.detectCommitment('I will get back to you within 2 hours.');
    timed.dueInMinutes === 120
      ? ok('a stated deadline is honoured', '"within 2 hours" -> 120 minutes')
      : no('a stated deadline is honoured', `${timed.dueInMinutes}m`);

    // ── 2. Kept ─────────────────────────────────────────────────────────────
    console.log('\n2. A promise the business kept');
    const keptConv = await conversation(orgId, {
      question: 'Do you deliver to Whitefield?',
      reply: 'Let me check that and get back to you.',
      minutesAgo: 300,
    });
    await promise(orgId, keptConv, {
      reply: 'Let me check that and get back to you.', dueMinutesAgo: 60,
    });
    // The business answered afterwards — by a human, which must count.
    await db.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
       VALUES ($1, $2, 'human_agent', 'Yes, we deliver to Whitefield on Tuesdays.',
               NOW() - INTERVAL '30 minutes')`,
      [orgId, keptConv],
    );

    // ── 3. Broken ───────────────────────────────────────────────────────────
    console.log('   ...and one it did not');
    const brokenConv = await conversation(orgId, {
      question: 'What is the warranty on the sofa?',
      reply: 'I will confirm the warranty and get back to you shortly.',
      minutesAgo: 300,
    });
    await promise(orgId, brokenConv, {
      reply: 'I will confirm the warranty and get back to you shortly.', dueMinutesAgo: 120,
    });

    // ── 4. Cancelled ────────────────────────────────────────────────────────
    const doneConv = await conversation(orgId, {
      question: 'Can you check stock?',
      reply: 'Let me check that and get back to you.',
      minutesAgo: 300, status: 'resolved',
    });
    await promise(orgId, doneConv, {
      reply: 'Let me check that and get back to you.', dueMinutesAgo: 120,
    });

    const settled = await db.query(`SELECT * FROM settle_commitments($1::uuid)`, [orgId]);
    const s = settled.rows[0];
    Number(s.kept) === 1
      ? ok('the answered promise is KEPT', 'a colleague replying counts, not just the agent')
      : no('the answered promise is KEPT', `kept=${s.kept}`);
    Number(s.broken) === 1
      ? ok('the unanswered overdue promise is BROKEN')
      : no('the unanswered overdue promise is BROKEN', `broken=${s.broken}`);
    Number(s.cancelled) === 1
      ? ok('a promise on a conversation the customer closed is CANCELLED',
        'not counted against the business')
      : no('a promise on a conversation the customer closed is CANCELLED', `cancelled=${s.cancelled}`);

    // ── 5. Idempotence ──────────────────────────────────────────────────────
    console.log('\n3. Settling twice changes nothing');
    const again = await db.query(`SELECT * FROM settle_commitments($1::uuid)`, [orgId]);
    Number(again.rows[0].kept) === 0 && Number(again.rows[0].broken) === 0
      ? ok('a second settle decides nothing new')
      : no('a second settle decides nothing new', JSON.stringify(again.rows[0]));

    // ── 6. One obligation per reply ─────────────────────────────────────────
    console.log('\n4. A Temporal retry does not open a second obligation');
    const dupeSrc = `dupe-${stamp}`;
    for (let i = 0; i < 3; i++) {
      await db.query(
        `SELECT record_commitment($1::uuid, $2::uuid, NULL, 'I will get back to you.',
                                  'q', 240, $3::text)`,
        [orgId, brokenConv, dupeSrc]);
    }
    const dupes = await db.query(
      `SELECT COUNT(*)::int AS n FROM commitments WHERE org_id = $1 AND source_message_id = $2`,
      [orgId, dupeSrc]);
    dupes.rows[0].n === 1
      ? ok('three replays produced ONE obligation', 'or the kept rate falls whenever the platform retries')
      : no('three replays produced ONE obligation', `${dupes.rows[0].n}`);

    // ── 7. Escalation, once ─────────────────────────────────────────────────
    console.log('\n5. An unkept promise reaches a human — exactly once');
    await db.query(
      `INSERT INTO org_automation (org_id, trigger_key, mode, config)
       VALUES ($1, 'commitment.due', 'on', '{}'::jsonb)`, [orgId]);

    const ENGINE = path.join(__dirname, 'trigger-engine.js');
    const run = () => spawnSync(process.execPath, [ENGINE, '--org', orgId],
      { encoding: 'utf8', env: process.env });

    const out1 = run();
    const escalated = await db.query(
      `SELECT COUNT(*)::int AS n FROM commitments
        WHERE org_id = $1 AND escalated_at IS NOT NULL`, [orgId]);
    escalated.rows[0].n >= 1
      ? ok('the broken promise was escalated', `${escalated.rows[0].n}`)
      : no('the broken promise was escalated', `${(out1.stdout || '').slice(-200)}`);

    const conv = await db.query(
      `SELECT status FROM conversations WHERE id = $1`, [brokenConv]);
    conv.rows[0].status === 'needs_attention'
      ? ok('the conversation is raised for a human', 'not auto-replied to unattended')
      : no('the conversation is raised for a human', conv.rows[0].status);

    run();
    run();
    const fires = await db.query(
      `SELECT COUNT(*)::int AS n FROM trigger_dispatches
        WHERE org_id = $1 AND trigger_key = 'commitment.due'`, [orgId]);
    fires.rows[0].n === 1
      ? ok('three engine runs escalated it once', 'not once an hour, forever')
      : no('three engine runs escalated it once', `${fires.rows[0].n} fires`);

    // ── 8. Isolation ────────────────────────────────────────────────────────
    console.log('\n6. Promises are tenant-scoped');
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.current_org_id', $1, true)`,
      ['00000000-0000-4000-8000-000000000001']);
    await db.query('SET LOCAL ROLE darex_app');
    const leak = await db.query(
      `SELECT COUNT(*)::int AS n FROM commitments WHERE org_id = $1`, [orgId]);
    await db.query('ROLLBACK');
    leak.rows[0].n === 0
      ? ok('another tenant cannot read these promises')
      : no('another tenant cannot read these promises', `${leak.rows[0].n} visible`);
  } finally {
    await db.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await db.end();
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
