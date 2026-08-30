#!/usr/bin/env node
'use strict';
/**
 * ONE PERSON, HOWEVER THEY WRITE TO YOU — and can you erase them?
 *
 * Migration 038 gave erasure a routine keyed on one exact spelling of a
 * handle. Somebody who messaged from +919799992973 in March and 09799992973 in
 * July was TWO subjects, so honouring their request erased half of them. The
 * half left behind still held their messages, and the agent would still have
 * answered from what it learned there.
 *
 * That is the defect this suite exists to close, and the assertion that
 * matters is the last one: erase by ANY handle, and every conversation from
 * EVERY handle is gone.
 *
 * ── THE OTHER HALF IS MORE IMPORTANT ──────────────────────────────────────
 * Merging is a claim that two conversations belong to one human. A wrong claim
 * shows a customer somebody else's budget and address. So this file spends
 * more assertions on what must NOT merge than on what must.
 *
 * Usage: node infra/scripts/check-identity.js
 * Exit:  0 = identity resolves and erasure reaches all of it, 1 = it does not
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

const cfg = (user, password) => ({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user, password, database: process.env.DB_NAME || 'darex',
});
const db = new Client(cfg(
  process.env.DB_RESOLVER_USER || 'darex',
  process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret'));
const app = new Client(cfg(
  process.env.DB_USER || 'darex_app', process.env.DB_PASSWORD || 'darex_dev_secret'));

const stamp = Date.now();
// A real Indian mobile, written the four ways a person and three channels
// would actually write it.
const N = `9${String(stamp).slice(-9)}`;
const SPELLINGS = [`+91${N}`, `91${N}`, `0${N}`, N];
const OTHER = `9${String(stamp + 12345).slice(-9)}`;

async function seedConversation(orgId, handle, text) {
  const conv = (await db.query(
    `INSERT INTO conversations (org_id, contact_id, status) VALUES ($1,$2::text,'open') RETURNING id`,
    [orgId, handle])).rows[0].id;
  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1,$2,'user',$3)`,
    [orgId, conv, text]);
  // A fact the agent learned. This is what survives a naive erasure.
  await db.query(
    `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
     VALUES ($1,'fact','budget',$2,'conversation',$3::text,$4)`,
    [orgId, `Budget noted from ${handle}`, conv, `h-${handle}-${stamp}`]);
  return conv;
}

(async () => {
  await db.connect();
  await app.connect();
  console.log('\n=== IDENTITY — ONE PERSON, AND CAN YOU ERASE THEM? ===\n');

  const orgs = [];
  try {
    const mk = async (tag) => {
      const id = (await db.query(
        `INSERT INTO orgs (name, slug) VALUES ($1,$1) RETURNING id`, [`ident-${tag}-${stamp}`])).rows[0].id;
      orgs.push(id);
      return id;
    };
    const A = await mk('a');
    const B = await mk('b');

    // ── 1. The same human, four spellings ───────────────────────────────────
    console.log('1. One person writes from four different renderings of one number');
    for (const s of SPELLINGS) await seedConversation(A, s, `Enquiry from ${s}`);
    await seedConversation(A, OTHER, 'A different person entirely');
    await seedConversation(A, 'unknown', 'An anonymous sender');
    await seedConversation(A, 'unknown', 'A second, unrelated anonymous sender');
    ok('seeded', `${SPELLINGS.length} spellings of one number, 1 other person, 2 anonymous`);

    // ── 2. Backfill ─────────────────────────────────────────────────────────
    console.log('\n2. The backfill resolves them');
    const run = spawnSync(process.execPath,
      [path.join(__dirname, 'backfill-identity.js'), '--org', A, '--write'],
      { encoding: 'utf8', env: process.env, timeout: 180000 });
    const out = String(run.stdout || '') + String(run.stderr || '');

    const people = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM contact_persons WHERE org_id=$1`, [A])).rows[0].n);
    // 4 spellings -> 1 person, plus the other number, plus TWO anonymous who
    // must stay separate = 4.
    people === 4
      ? ok('7 conversations became 4 people', '4 spellings collapsed to 1')
      : no('7 conversations became 4 people', `${people} people`);

    /one person from 4 spellings/i.test(out)
      ? ok('and it printed the merge for a human to check',
        'a wrong merge is a privacy breach; a count cannot be checked by eye')
      : no('and it printed the merge', out.split('\n').filter((l) => /spelling/.test(l)).join(' | '));

    const merged = await db.query(
      `SELECT COUNT(DISTINCT person_id)::int AS n FROM conversations
        WHERE org_id=$1 AND contact_id = ANY($2::text[])`, [A, SPELLINGS]);
    merged.rows[0].n === 1
      ? ok('all four conversations point at ONE person')
      : no('all four conversations point at one person', `${merged.rows[0].n} people`);

    // ── 3. What must NOT merge ──────────────────────────────────────────────
    console.log('\n3. And the things that must never merge, did not');
    const anon = await db.query(
      `SELECT COUNT(DISTINCT person_id)::int AS n FROM conversations
        WHERE org_id=$1 AND contact_id='unknown'`, [A]);
    anon.rows[0].n === 2
      ? ok('two anonymous senders stayed two people',
        'if "unknown" were an identity, every anonymous sender would read the others\' history')
      : no('two anonymous senders stayed two people', `${anon.rows[0].n} — THEY WERE MERGED`);

    const otherPerson = await db.query(
      `SELECT person_id FROM conversations WHERE org_id=$1 AND contact_id=$2`, [A, OTHER]);
    const onePerson = await db.query(
      `SELECT person_id FROM conversations WHERE org_id=$1 AND contact_id=$2`, [A, SPELLINGS[0]]);
    otherPerson.rows[0].person_id !== onePerson.rows[0].person_id
      ? ok('a different number is a different person')
      : no('a different number is a different person', 'TWO CUSTOMERS WERE MERGED');

    // ── 4. THE ONE THAT MATTERS ─────────────────────────────────────────────
    console.log('\n4. Erase by ANY handle — every one of them goes');
    const before = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM conversations WHERE org_id=$1 AND contact_id = ANY($2::text[])`,
      [A, SPELLINGS])).rows[0].n);
    before === 4 ? ok('4 conversations exist across the four spellings')
      : no('4 conversations exist', `${before}`);

    // Erase using the LAST spelling. Under migration 038 this would have
    // removed one conversation and left three.
    const res = await db.query(
      `SELECT handles_erased, erased FROM erase_person($1::uuid, $2::text, 'data_subject_request', NULL)`,
      [A, SPELLINGS[3]]);
    Number(res.rows[0].handles_erased) === 4
      ? ok('it erased across all four handles', 'not just the one it was given')
      : no('it erased across all four handles', `${res.rows[0].handles_erased}`);

    const after = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM conversations WHERE org_id=$1 AND contact_id = ANY($2::text[])`,
      [A, SPELLINGS])).rows[0].n);
    after === 0
      ? ok('EVERY conversation from that person is gone', '4 -> 0')
      : no('EVERY conversation from that person is gone', `${after} left behind`);

    const mem = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM org_memory WHERE org_id=$1 AND content_hash LIKE $2`,
      [A, `h-%-${stamp}`])).rows[0].n);
    // Only the other person's and the anonymous ones' facts should remain.
    mem === 3
      ? ok('and so is everything the agent learned from them', 'derived memory erased with the person')
      : no('and so is everything the agent learned from them', `${mem} facts remain, expected 3`);

    const idents = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM contact_identities ci
        JOIN contact_persons cp ON cp.id = ci.person_id
       WHERE ci.org_id=$1 AND ci.value_raw = ANY($2::text[])`, [A, SPELLINGS])).rows[0].n);
    idents === 0
      ? ok('the phone numbers themselves are gone', 'value_raw IS the number — it is personal data')
      : no('the phone numbers themselves are gone', `${idents} identity row(s) remain`);

    const survivor = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM conversations WHERE org_id=$1 AND contact_id=$2`,
      [A, OTHER])).rows[0].n);
    survivor === 1
      ? ok('and the other customer is untouched', 'erasure reached exactly one person')
      : no('and the other customer is untouched', `${survivor}`);

    // ── 5. Isolation ────────────────────────────────────────────────────────
    console.log('\n5. Identity does not cross a workspace boundary');
    await seedConversation(B, SPELLINGS[0], 'Same number, different business');
    spawnSync(process.execPath,
      [path.join(__dirname, 'backfill-identity.js'), '--org', B, '--write'],
      { encoding: 'utf8', env: process.env, timeout: 180000 });

    const bPeople = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM contact_persons WHERE org_id=$1`, [B])).rows[0].n);
    bPeople === 1
      ? ok('the same number in another workspace is a separate person',
        'two businesses sharing a customer must not share their history')
      : no('the same number in another workspace is a separate person', `${bPeople}`);

    await app.query("SELECT set_config('app.current_org_id', $1, false)", [B]);
    const leak = Number((await app.query(
      `SELECT COUNT(*)::int AS n FROM contact_persons WHERE org_id = $1`, [A])).rows[0].n);
    leak === 0
      ? ok('and cannot be read across the boundary', 'asserted as darex_app under RLS')
      : no('and cannot be read across the boundary', `${leak} row(s) leaked`);
  } finally {
    if (orgs.length) await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [orgs]).catch(() => {});
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
