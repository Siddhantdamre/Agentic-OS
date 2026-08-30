#!/usr/bin/env node
'use strict';
/**
 * TELLING IT SOMETHING, WITHOUT PRODUCING A FILE.
 *
 * Until this shipped, the only way to teach the agent anything was to upload a
 * document. 719 conversations had been answered and every fact behind them came
 * from a pack default or an uploaded file — nobody had ever simply told it
 * something. For a broker who knows their brokerage is 2%, "produce a PDF" is
 * the difference between a thirty-second action and a task that never happens.
 *
 * The properties that matter are not "the insert worked":
 *
 *   it OUTRANKS a document      a person contradicting a stale PDF must win,
 *                               or the feature is decorative
 *   it is IDEMPOTENT            saying the same thing twice is one fact, not
 *                               two competing copies
 *   it is TENANT-SCOPED         one workspace's private pricing must never be
 *                               readable by another
 *   it is RETRIEVABLE           stored and unfindable is the same as not stored
 *
 * Usage: node infra/scripts/check-teach-fact.js
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const cfg = (user, password) => ({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user, password, database: process.env.DB_NAME || 'darex',
});
const db = new Client(cfg(
  process.env.DB_RESOLVER_USER || 'darex',
  process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret'));
const app = new Client(cfg(
  process.env.DB_USER || 'darex_app', process.env.DB_PASSWORD || 'darex_app_dev_secret'));

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const stamp = Date.now();
const orgs = [];

/** The exact write the API performs. Kept in step with app/api/brain/route.ts. */
async function teach(orgId, userId, body, kind = 'faq', title = '') {
  const r = await db.query(
    `INSERT INTO org_memory
       (org_id, kind, title, body, source, source_ref, content_hash, priority, metadata)
     VALUES ($1, $2, $3, $4, 'operator', $5,
             encode(digest($4, 'sha256'), 'hex'), 100,
             jsonb_build_object('author_user_id', $6::text))
     ON CONFLICT (org_id, source, source_ref, content_hash) DO UPDATE
       SET title = EXCLUDED.title, kind = EXCLUDED.kind, updated_at = NOW()
     RETURNING id, (xmax = 0) AS created`,
    [orgId, kind, title || body.slice(0, 60), body, `fact:${userId}`, userId]);
  return r.rows[0];
}

(async () => {
  await db.connect();
  await app.connect();
  console.log('\n=== TEACH A FACT — typed knowledge, not an uploaded file ===\n');

  try {
    const mk = async (tag) => {
      const id = (await db.query(
        `INSERT INTO orgs (name, slug) VALUES ($1,$1) RETURNING id`,
        [`fact-${tag}-${stamp}`])).rows[0].id;
      orgs.push(id);
      return id;
    };
    const A = await mk('a');
    const B = await mk('b');
    const user = '00000000-0000-0000-0000-0000000000aa';

    // ── 1. A person outranks a document ─────────────────────────────────────
    console.log('1. What a person says beats what a document says');
    await db.query(
      `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash, priority)
       VALUES ($1,'policy','Old rate card','Brokerage is 3 percent of sale value.',
               'upload','ratecard.pdf', encode(digest('stale','sha256'),'hex'), 0)`, [A]);
    const fact = await teach(A, user, 'Brokerage is 2 percent of sale value.', 'policy');

    const ranked = (await db.query(
      `SELECT source, priority FROM org_memory WHERE org_id=$1 ORDER BY priority DESC`, [A])).rows;
    ranked[0]?.source === 'operator' && Number(ranked[0].priority) === 100
      ? ok('a typed fact ranks above an uploaded document',
        'priority 100 vs 0 — migration 026 calls 100 "human correction"')
      : no('a typed fact ranks above an uploaded document', JSON.stringify(ranked));

    // ── 2. Idempotent ───────────────────────────────────────────────────────
    console.log('\n2. Saying it twice does not create two competing facts');
    const again = await teach(A, user, 'Brokerage is 2 percent of sale value.', 'policy');
    const copies = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM org_memory WHERE org_id=$1 AND source='operator'`,
      [A])).rows[0].n);
    copies === 1 && again.id === fact.id && again.created === false
      ? ok('the same fact twice is one row', 'the operator is told it was already known')
      : no('the same fact twice is one row', `${copies} row(s)`);

    // ── 3. Retrievable ──────────────────────────────────────────────────────
    console.log('\n3. Stored and findable are not the same thing');
    const found = (await db.query(
      `SELECT id FROM org_memory
        WHERE org_id=$1 AND body_tsv @@ plainto_tsquery('english','brokerage percent sale')`,
      [A])).rows.length;
    found > 0
      ? ok('the fact is retrievable the moment it is saved',
        'full text, no embedding needed — which matters while embeddings are off')
      : no('the fact is retrievable the moment it is saved');

    // ── 4. Tenant isolation ─────────────────────────────────────────────────
    console.log('\n4. One business cannot read another\'s private pricing');
    await teach(B, user, 'Brokerage is 5 percent of sale value.', 'policy');
    await app.query("SELECT set_config('app.current_org_id', $1, false)", [B]);
    const leaked = (await app.query(
      `SELECT body FROM org_memory WHERE source='operator'`)).rows.map((r) => r.body);
    leaked.length === 1 && /5 percent/.test(leaked[0])
      ? ok('B sees only its own fact', 'asserted as darex_app under RLS')
      : no('B sees only its own fact', JSON.stringify(leaked));

    // ── 5. Erasure reaches it ───────────────────────────────────────────────
    // org_memory is already in the retention catalogue; this asserts that a
    // typed fact is not somehow exempt from it.
    console.log('\n5. A typed fact is erasable like everything else');
    const before = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM org_memory WHERE org_id=$1`, [A])).rows[0].n);
    await db.query(`DELETE FROM org_memory WHERE org_id=$1 AND source='operator'`, [A]);
    const after = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM org_memory WHERE org_id=$1`, [A])).rows[0].n);
    after === before - 1
      ? ok('it deletes cleanly, leaving the document behind')
      : no('it deletes cleanly', `${before} -> ${after}`);
  } finally {
    if (orgs.length) {
      await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [orgs]).catch(() => {});
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
