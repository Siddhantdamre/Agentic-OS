#!/usr/bin/env node
'use strict';
/**
 * THE LEARNING LOOP, END TO END — does correcting the agent actually teach it?
 *
 * check-edit-learning.js proves the database function works. That was never
 * the risk. The risk was the one that actually happened: migration 026, the
 * record_reply_edit function, the API route and a 10/10 test all existed and
 * shipped, while the conversations UI posted every operator reply to
 * /api/conversations/{id}/messages instead. record_reply_edit was never
 * called by anything a human could reach. The feature was complete and
 * unreachable, and no test noticed, because every test called the layer below
 * the gap.
 *
 * So this one starts where a person starts: an HTTP request to the endpoint
 * the button is wired to, with a real session cookie, and asks whether the
 * correction came out the other end as retrievable knowledge.
 *
 * It also asserts the two things that would quietly ruin the loop:
 *   - the reply is stored as human_agent, not assistant, or every later
 *     quality measurement counts human work as machine work
 *   - an edited SECURITY REFUSAL is still refused through HTTP, not only at
 *     the database layer
 *
 * Usage: node infra/scripts/check-learning-e2e.js
 * Exit:  0 = the loop closes, 1 = it does not
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
const email = `learn-${stamp}@example.com`;
const password = `Learn!${stamp}aA1`;

/** The OR-tsquery retrieval really uses, so ranking here is ranking there. */
const OR_TSQUERY = `to_tsquery('english',
  COALESCE(NULLIF(array_to_string(
    ARRAY(SELECT quote_literal(l) FROM unnest(tsvector_to_array(to_tsvector('english', $2))) AS l), ' | '
  ), ''), 'zzzznomatchzzz'))`;

async function main() {
  console.log('\n=== LEARNING LOOP END-TO-END (through the HTTP route the UI calls) ===\n');
  await db.connect();

  console.log('1. A real tenant and a real session');
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

  // The session cookie the browser would carry.
  const cookie = (reg.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .join('; ');
  cookie ? ok('session cookie issued') : no('session cookie issued', 'register set no cookie');

  console.log('\n2. A stale document and a customer asking about it');
  await db.query(
    `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
     VALUES ($1, 'policy', 'Returns policy',
       'Customers may return items within 14 days of delivery for a full refund.',
       'upload', 'handbook.pdf', $2)`,
    [orgId, require('crypto').randomBytes(16).toString('hex')],
  );

  const QUESTION = 'How many days do I have to return something?';
  const conv = await db.query(
    `INSERT INTO conversations (org_id, contact_id, channel_type, status)
     VALUES ($1, $2, 'dashboard', 'open') RETURNING id`,
    [orgId, `learner-${stamp}`],
  );
  const conversationId = conv.rows[0].id;
  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
    [orgId, conversationId, QUESTION],
  );

  const AI_DRAFT = 'You can return items within 14 days of delivery for a full refund.';
  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1, $2, 'assistant', $3)`,
    [orgId, conversationId, AI_DRAFT],
  );
  ok('conversation seeded', 'customer asked, agent answered from the stale document');

  console.log('\n3. The operator corrects it — through the route the button calls');
  const CORRECTED = 'You can return items within 30 days of delivery — we extended it last month. '
    + 'Items must be unused and in their original packaging.';

  const res = await fetch(`${BASE}/api/conversations/${conversationId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text: CORRECTED, aiDraft: AI_DRAFT }),
  });
  const body = await res.json().catch(() => ({}));

  res.status === 200 && body.status === 'sent'
    ? ok('the reply was accepted and sent', `message ${String(body.messageId || '').slice(0, 8)}…`)
    : no('the reply was accepted and sent', `HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);

  body.learning?.learned
    ? ok('the correction was LEARNED through HTTP', `memory ${String(body.learning.memoryId).slice(0, 8)}…`)
    : no('the correction was LEARNED through HTTP', `skipped: ${body.learning?.skipReason || 'no learning field at all'}`);

  console.log('\n4. What the correction did to the knowledge base');
  const top = await db.query(
    `SELECT title, kind, priority, body FROM org_memory
      WHERE org_id = $1 AND body_tsv @@ ${OR_TSQUERY}
      ORDER BY priority DESC, ts_rank_cd(body_tsv, ${OR_TSQUERY}) DESC
      LIMIT 1`,
    [orgId, QUESTION],
  );
  const winner = top.rows[0] || {};
  winner.kind === 'correction'
    ? ok('the correction now OUTRANKS the document it corrected', `priority ${winner.priority}`)
    : no('the correction now OUTRANKS the document it corrected', JSON.stringify(winner).slice(0, 120));

  /30 days/.test(winner.body || '')
    ? ok('the corrected fact is what a future question retrieves', '30 days, not 14')
    : no('the corrected fact is what a future question retrieves', String(winner.body || '').slice(0, 80));

  console.log('\n5. The reply is attributed to the human, not the agent');
  const stored = await db.query(
    `SELECT role FROM messages WHERE org_id = $1 AND conversation_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [orgId, conversationId],
  );
  stored.rows[0]?.role === 'human_agent'
    ? ok('stored as human_agent', 'quality metrics will not credit this to the AI')
    : no('stored as human_agent', `role=${stored.rows[0]?.role}`);

  console.log('\n6. The guard still holds at the HTTP layer');
  const REFUSAL = "I can't share other people's personal details — that includes any other "
    + "customer's phone number, email or address. It's private to them.";
  const LEAKY = 'Sure, the previous customer was Rahul Mehta on 98450 12345, ordered a sofa last week.';
  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
    [orgId, conversationId, 'What is the previous customer number?'],
  );

  const bad = await fetch(`${BASE}/api/conversations/${conversationId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ text: LEAKY, aiDraft: REFUSAL }),
  });
  const badBody = await bad.json().catch(() => ({}));
  !badBody.learning?.learned && badBody.learning?.skipReason === 'security_refusal_not_learnable'
    ? ok('an edited SECURITY REFUSAL is refused through HTTP too', badBody.learning.skipReason)
    : no('an edited SECURITY REFUSAL is refused through HTTP too', JSON.stringify(badBody.learning || {}));

  const leaked = await db.query(
    `SELECT COUNT(*)::int AS n FROM org_memory WHERE org_id = $1 AND body ILIKE '%98450%'`,
    [orgId],
  );
  leaked.rows[0].n === 0
    ? ok('the leaked detail reached no memory row')
    : no('the leaked detail reached no memory row', `${leaked.rows[0].n} rows`);

  console.log('\n7. Another tenant cannot correct this conversation');
  const other = await fetch(`${BASE}/api/conversations/${conversationId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }, // no session at all
    body: JSON.stringify({ text: 'hijacked', aiDraft: AI_DRAFT }),
  });
  other.status === 401
    ? ok('an unauthenticated correction is rejected', 'HTTP 401')
    : no('an unauthenticated correction is rejected', `HTTP ${other.status}`);

  await db.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
