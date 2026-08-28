#!/usr/bin/env node
'use strict';
/**
 * THE MONDAY EMAIL — does the right business get the right numbers?
 *
 * The content builder has 18 unit tests covering wording and arithmetic. What
 * those cannot cover is the part that only exists once a database is involved,
 * and it is the part where a mistake is unrecoverable:
 *
 *   - one tenant's questions appearing in another tenant's email
 *   - a member receiving a report meant for the owner
 *   - a business being told its AI handled 100% when it handled none
 *
 * The first of those ends a customer relationship in a single message, and no
 * apology undoes it, because the recipient has already read someone else's
 * business.
 *
 * Email sending is MOCKED by running in preview mode: nothing leaves the
 * machine, and the intended recipients are printed, which is exactly what
 * needs asserting.
 *
 * Usage: node infra/scripts/check-digest.js
 * Exit:  0 = safe to send, 1 = not
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
const SCRIPT = path.join(__dirname, 'weekly-digest.js');
let seq = 0;

/** Preview one org. Nothing is sent — this is the mock. */
function preview(orgId) {
  const r = spawnSync(process.execPath, [SCRIPT, '--org', orgId], {
    encoding: 'utf8', env: process.env,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

async function makeOrg(label) {
  const r = await db.query(
    `INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`${label} ${stamp}`, `digest-${label.toLowerCase()}-${stamp}`],
  );
  return r.rows[0].id;
}

async function addUser(orgId, role) {
  const email = `${role}-${stamp}-${seq++}@example.com`;
  await db.query(
    `INSERT INTO users (org_id, email, role) VALUES ($1, $2, $3)`,
    [orgId, email, role],
  );
  return email;
}

/** A conversation that finished last week, autonomous or not. */
async function finished(orgId, kind, daysAgo = 3) {
  const c = await db.query(
    `INSERT INTO conversations (org_id, contact_id, status, started_at, resolved_at, metadata)
     VALUES ($1, $2, 'resolved',
             NOW() - ($3 || ' days')::interval,
             NOW() - ($3 || ' days')::interval,
             jsonb_build_object('resolution', jsonb_build_object('kind', $4::text)))
     RETURNING id`,
    [orgId, `c-${stamp}-${seq++}`, String(daysAgo), kind],
  );
  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
     VALUES ($1, $2, 'assistant', 'answered', NOW() - ($3 || ' days')::interval)`,
    [orgId, c.rows[0].id, String(daysAgo)],
  );
  return c.rows[0].id;
}

async function addGap(orgId, question, timesAsked) {
  await db.query(
    `INSERT INTO knowledge_gaps (org_id, question, question_hash, times_asked, status)
     VALUES ($1, $2, md5($2 || $3::text), $4, 'open')`,
    [orgId, question, String(seq++), timesAsked],
  );
}

(async () => {
  await db.connect();
  console.log('\n=== WEEKLY DIGEST — RECIPIENTS, SCOPING, CONTENT ===\n');

  const orgA = await makeOrg('DigestA');
  const orgB = await makeOrg('DigestB');
  const empty = await makeOrg('DigestEmpty');

  try {
    console.log('1. Two businesses with different weeks');
    const ownerA = await addUser(orgA, 'owner');
    const memberA = await addUser(orgA, 'member');
    const ownerB = await addUser(orgB, 'owner');
    await addUser(empty, 'owner');

    // A: 3 handled alone, 1 needed a person -> 75%
    await finished(orgA, 'autonomous');
    await finished(orgA, 'autonomous');
    await finished(orgA, 'autonomous');
    await finished(orgA, 'with_human');
    await addGap(orgA, 'Do you deliver to Whitefield?', 11);
    await addGap(orgA, 'What is the warranty?', 2);

    // B: 1 handled alone -> 100%, with a completely different question
    await finished(orgB, 'autonomous');
    await addGap(orgB, 'Is there parking at the showroom?', 4);

    ok('seeded', 'A: 3 of 4 alone + 2 questions · B: 1 of 1 + 1 question · Empty: nothing');

    console.log('\n2. The numbers belong to the right business');
    const outA = preview(orgA);
    const outB = preview(orgB);

    /75%/.test(outA)
      ? ok('A is told 75%', '3 of the 4 that finished')
      : no('A is told 75%', outA.split('\n').filter((l) => /handled/.test(l)).join(' | '));
    /100%/.test(outB)
      ? ok('B is told 100%')
      : no('B is told 100%', outB.split('\n').filter((l) => /handled/.test(l)).join(' | '));

    console.log('\n3. One tenant never sees another tenant\'s customers');
    !/parking at the showroom/i.test(outA)
      ? ok("A's email carries none of B's questions", 'the failure that ends a relationship')
      : no("A's email carries none of B's questions", 'CROSS-TENANT LEAK');
    !/Whitefield/i.test(outB)
      ? ok("B's email carries none of A's questions")
      : no("B's email carries none of A's questions", 'CROSS-TENANT LEAK');
    !new RegExp(ownerB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(outA)
      ? ok("B's owner is not on A's recipient list")
      : no("B's owner is not on A's recipient list", 'CROSS-TENANT LEAK');

    console.log('\n4. Only owners and admins receive it');
    new RegExp(ownerA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(outA)
      ? ok('the owner is a recipient')
      : no('the owner is a recipient', outA.slice(-300));
    !new RegExp(memberA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(outA)
      ? ok('an ordinary member is not', 'a digest reports where the AI needed help')
      : no('an ordinary member is not');

    const admin = await addUser(orgA, 'admin');
    const outAdmin = preview(orgA);
    new RegExp(admin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(outAdmin)
      ? ok('an admin is a recipient')
      : no('an admin is a recipient');

    console.log('\n5. The questions appear, most-asked first');
    /Whitefield/.test(outA)
      ? ok("A's open questions are in the email")
      : no("A's open questions are in the email");
    outA.indexOf('Whitefield') < outA.indexOf('warranty')
      ? ok('ranked by how often they were asked', '11 before 2')
      : no('ranked by how often they were asked');
    /asked 11 times/.test(outA)
      ? ok('the count is shown, so the reader knows what it is costing')
      : no('the count is shown');

    console.log('\n6. Nothing to say means no email');
    const outEmpty = preview(empty);
    /1 org\(s\) · 0 digest\(s\)/.test(outEmpty) || /0 digest/.test(outEmpty)
      ? ok('a quiet business gets nothing', 'a zero-everything email trains people to delete it')
      : no('a quiet business gets nothing', outEmpty.split('\n').slice(-6).join(' | '));

    console.log('\n7. Nothing was actually sent');
    /nothing sent \(preview\)/.test(outA)
      ? ok('preview is the default', 'sending needs an explicit --send')
      : no('preview is the default');
  } finally {
    await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[orgA, orgB, empty]]);
    await db.end();
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
