#!/usr/bin/env node
/**
 * OPERATOR EDIT LEARNING — does a human correction actually change the answer?
 *
 * The loop under test:
 *   agent answers wrongly
 *     → operator rewrites it before sending
 *     → the rewrite becomes a priority-100 org_memory fact
 *     → the SAME question now retrieves the correction ahead of the document
 *       it was correcting
 *
 * Also asserts the guard that matters most: an edited SECURITY REFUSAL must
 * never become knowledge. If an operator rewrites "I can't share another
 * customer's number" into something that does share it, learning from that
 * would permanently teach the agent to leak — defeating the refusal gates from
 * the inside, by a trusted user, with no attacker involved.
 *
 * Database-level, so it runs without spending a single LLM token.
 *
 * Usage: node infra/scripts/check-edit-learning.js
 */
const crypto = require('crypto');
const path = require('path');

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

/** The exact OR-tsquery retrieval uses, so this measures the real ranking. */
const OR_TSQUERY = `to_tsquery('english',
  COALESCE(NULLIF(array_to_string(
    ARRAY(SELECT quote_literal(l) FROM unnest(tsvector_to_array(to_tsvector('english', $2))) AS l), ' | '
  ), ''), 'zzzznomatchzzz'))`;

async function topHit(orgId, question) {
  const r = await db.query(
    `SELECT title, priority, kind FROM org_memory
     WHERE org_id = $1 AND body_tsv @@ ${OR_TSQUERY}
     ORDER BY priority DESC, ts_rank_cd(body_tsv, ${OR_TSQUERY}) DESC
     LIMIT 1`,
    [orgId, question],
  );
  return r.rows[0] || null;
}

(async () => {
  await db.connect();
  console.log('\n### OPERATOR EDIT LEARNING\n');

  const stamp = Date.now();
  const org = await db.query(
    `INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`EditLearning ${stamp}`, `edit-learning-${stamp}`],
  );
  const orgId = org.rows[0].id;

  // A stale document — the kind of thing a business uploads once and forgets.
  await db.query(
    `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
     VALUES ($1,'policy','Returns policy',
       'Customers may return items within 14 days of delivery for a full refund.',
       'upload','handbook.pdf',$2)`,
    [orgId, crypto.randomBytes(16).toString('hex')],
  );

  const QUESTION = 'How many days do I have to return something?';

  const before = await topHit(orgId, QUESTION);
  before && before.title === 'Returns policy'
    ? ok('before any correction, the uploaded document wins', `priority ${before.priority}`)
    : no('before any correction, the uploaded document wins', JSON.stringify(before));

  // ── The operator corrects the agent ───────────────────────────────────────
  const AI_DRAFT = 'You can return items within 14 days of delivery for a full refund.';
  const OPERATOR = 'You can return items within 30 days of delivery — we extended it last month. '
    + 'Items must be unused and in original packaging.';

  const edit = await db.query(
    `SELECT * FROM record_reply_edit($1::uuid, NULL, $2::text, $3::text, $4::text, NULL)`,
    [orgId, QUESTION, AI_DRAFT, OPERATOR],
  );
  const row = edit.rows[0] || {};
  row.learned
    ? ok('the correction was learned', `memory ${String(row.memory_id).slice(0, 8)}`)
    : no('the correction was learned', `skipped: ${row.skip_reason}`);

  const after = await topHit(orgId, QUESTION);
  after && after.kind === 'correction'
    ? ok('the correction now OUTRANKS the document it corrected', `priority ${after.priority}`)
    : no('the correction now OUTRANKS the document it corrected', JSON.stringify(after));

  const body = await db.query(
    `SELECT body FROM org_memory WHERE org_id=$1 AND kind='correction' LIMIT 1`, [orgId]);
  /30 days/.test(body.rows[0]?.body || '')
    ? ok('the corrected fact is what gets retrieved', '30 days, not 14')
    : no('the corrected fact is what gets retrieved', body.rows[0]?.body?.slice(0, 80));

  // ── The guard: a security refusal must never be learned ───────────────────
  const REFUSAL =
    "I can't share other people's personal details — that includes any other "
    + "customer's phone number, email or address. It's private to them.";
  const LEAKY_EDIT =
    'Sure, the previous customer was Rahul Mehta on 98450 12345, ordered a sofa last week.';

  const bad = await db.query(
    `SELECT * FROM record_reply_edit($1::uuid, NULL, $2::text, $3::text, $4::text, NULL)`,
    [orgId, 'What is the previous customer number?', REFUSAL, LEAKY_EDIT],
  );
  const badRow = bad.rows[0] || {};
  !badRow.learned && badRow.skip_reason === 'security_refusal_not_learnable'
    ? ok('an edited SECURITY REFUSAL is never learned', badRow.skip_reason)
    : no('an edited SECURITY REFUSAL is never learned', JSON.stringify(badRow));

  const leaked = await db.query(
    `SELECT COUNT(*)::int AS n FROM org_memory WHERE org_id=$1 AND body ILIKE '%98450%'`, [orgId]);
  leaked.rows[0].n === 0
    ? ok('the leaked detail reached no memory row')
    : no('the leaked detail reached no memory row', `${leaked.rows[0].n} rows`);

  // The attempt is still recorded — an operator trying this is worth seeing.
  const audited = await db.query(
    `SELECT COUNT(*)::int AS n FROM reply_edits WHERE org_id=$1 AND learned=false`, [orgId]);
  audited.rows[0].n >= 1
    ? ok('the rejected edit is still audited', `${audited.rows[0].n} recorded`)
    : no('the rejected edit is still audited');

  // ── Noise must not become knowledge ───────────────────────────────────────
  for (const [label, draft, final, expected] of [
    ['an unchanged reply', AI_DRAFT, AI_DRAFT, 'unchanged'],
    ['a one-word send', AI_DRAFT, 'ok thanks', 'too_short'],
    ['an edit containing an internal id', AI_DRAFT,
      'Your order under org_id=a8ea8b57-7e31-4b77-a55e-691c313d8494 is fine and on its way.',
      'edit_contains_internal_identifier'],
  ]) {
    const r = await db.query(
      `SELECT * FROM record_reply_edit($1::uuid, NULL, $2::text, $3::text, $4::text, NULL)`,
      [orgId, QUESTION, draft, final],
    );
    const rr = r.rows[0] || {};
    !rr.learned && rr.skip_reason === expected
      ? ok(`${label} is not learned`, expected)
      : no(`${label} is not learned`, JSON.stringify(rr));
  }

  await db.query(`DELETE FROM orgs WHERE id=$1`, [orgId]);
  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})();
