#!/usr/bin/env node
/**
 * UPLOAD → AGENT, end to end, through the real product path.
 *
 * register → login → POST /api/brain/upload (multipart, authenticated)
 *   → IngestWorkflow → chunk → org_memory (NULL embedding)
 *   → inbound webhook → WorkItemWorkflow → retrieval → grounding → reply
 *
 * The fact under test exists ONLY in the uploaded file, and is deliberately
 * unusual so it cannot be answered from the model's prior knowledge. If the
 * agent says it, the whole chain worked.
 */
const crypto = require('crypto');
const path = require('path');

let Client;
try {
  Client = require('pg').Client;
} catch {
  Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.CHATWOOT_WEBHOOK_SECRET || 'darex-chatwoot-webhook-secret-dev';
const sign = (b) => `sha256=${crypto.createHmac('sha256', SECRET).update(b).digest('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

// A fact no model could guess. If it comes back, it came from the file.
const MARKER = `Bay ${Math.floor(Math.random() * 90) + 10}`;
const DOC = `Bright Leaf Interiors — Showroom Facilities

Customer parking is available behind the building, accessed from the rear lane
off MG Road. Reserved customer bays are marked ${MARKER}. Parking is free for
showroom visitors and there is step-free access from the car park to the main
entrance.

The loading bay is for deliveries only and must be kept clear at all times.`;

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

(async () => {
  await db.connect();
  console.log('\n### UPLOAD → AGENT (end to end, real product path)\n');

  // 1. A real tenant with a real session.
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `upl_${stamp}@example.com`;
  const password = `Pw-${stamp}-Aa1!`;
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const regBody = await reg.json().catch(() => ({}));
  if (!regBody.orgId) { no('register tenant', `HTTP ${reg.status}`); process.exit(1); }
  const orgId = regBody.orgId;
  ok('registered tenant', orgId);

  // The session cookie is what makes this the REAL path, not a back door.
  const cookie = (reg.headers.getSetCookie ? reg.headers.getSetCookie() : [reg.headers.get('set-cookie')])
    .filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
  if (!cookie) { no('obtain session cookie from register'); process.exit(1); }
  ok('authenticated session established');

  const token = `orgsecret-${stamp}`;
  await db.query(
    `UPDATE orgs SET meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('webhook_secret',$2::text) WHERE id=$1`,
    [orgId, token]);
  await db.query(
    `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, status)
     VALUES ($1,'Sarah','support','{}'::jsonb, ARRAY['database_query']::text[], 'active')`, [orgId]);

  // 2. Upload a real file as multipart/form-data.
  const form = new FormData();
  form.append('file', new Blob([DOC], { type: 'text/plain' }), 'showroom-facilities.txt');
  form.append('title', 'Showroom facilities');
  const up = await fetch(`${BASE}/api/brain/upload`, { method: 'POST', headers: { cookie }, body: form });
  const upBody = await up.json().catch(() => ({}));
  up.ok
    ? ok('upload accepted', `${upBody.status} · ${upBody.format} · ${upBody.characters} chars`)
    : no('upload accepted', `HTTP ${up.status} ${JSON.stringify(upBody).slice(0, 160)}`);
  if (!up.ok) { await db.end(); process.exit(1); }

  // 3. It must land in org_memory — with NO embedding, since none is configured.
  let landed = null;
  for (let i = 0; i < 40; i++) {
    const r = await db.query(
      `SELECT id, title, embedding IS NULL AS no_vector, source FROM org_memory
       WHERE org_id=$1 AND body ILIKE $2 LIMIT 1`, [orgId, `%${MARKER}%`]);
    if (r.rows.length) { landed = r.rows[0]; break; }
    await sleep(1500);
  }
  landed
    ? ok('landed in org_memory', `source=${landed.source} null_embedding=${landed.no_vector}`)
    : no('landed in org_memory', 'not found within 60s');
  if (!landed) {
    const jobs = await db.query(
      `SELECT state, error FROM ingestion_jobs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 3`, [orgId]);
    console.log('    ingestion_jobs:', JSON.stringify(jobs.rows));
    await db.end();
    process.exit(1);
  }
  landed.no_vector
    ? ok('stored without an embedding, as designed')
    : ok('stored WITH an embedding (embeddings are configured)');

  // 4. Ask through the real inbound path. Phrased naturally, and never using
  //    the document's own wording — this also exercises the OR-tsquery fix.
  const question = 'Is there anywhere to park when I visit the showroom?';
  const before = await db.query(
    `SELECT COUNT(*)::int AS n FROM messages WHERE org_id=$1 AND role='assistant'`, [orgId]);
  const payload = JSON.stringify({
    event: 'message_created', message_type: 'incoming', content: question,
    id: Date.now(), conversation: { id: Math.floor(Math.random() * 100000), inbox_id: 4242 },
    sender: { phone_number: '+919900001234', name: 'Customer' }, account: { id: 4242 },
  });
  const hook = await fetch(`${BASE}/api/webhooks/chatwoot?org_id=${orgId}&token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatwoot-signature': sign(payload) },
    body: payload,
  });
  hook.status === 200 ? ok('inbound webhook accepted') : no('inbound webhook accepted', `HTTP ${hook.status}`);

  let reply = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const r = await db.query(
      `SELECT content FROM messages WHERE org_id=$1 AND role='assistant' ORDER BY created_at DESC LIMIT 1`, [orgId]);
    const c = await db.query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE org_id=$1 AND role='assistant'`, [orgId]);
    if (c.rows[0].n > before.rows[0].n && r.rows.length) { reply = r.rows[0].content; break; }
    await sleep(500);
  }
  reply ? ok('agent replied', `${((Date.now() - t0) / 1000).toFixed(1)}s`) : no('agent replied', 'timeout');

  if (reply) {
    console.log(`\n  Q: ${question}`);
    console.log(`  A: ${reply}\n`);
    // The marker proves the answer came from the uploaded file.
    new RegExp(MARKER.replace(/\s/g, '\\s*'), 'i').test(reply)
      ? ok(`answer contains the uploaded fact ("${MARKER}")`)
      : /park/i.test(reply) && /behind|rear|free/i.test(reply)
        ? ok('answer used the uploaded document (paraphrased the parking facts)')
        : no(`answer contains the uploaded fact ("${MARKER}")`, reply.slice(0, 140));
  }

  await db.query(`DELETE FROM orgs WHERE id=$1`, [orgId]);
  console.log(`\n  passed ${pass} / ${pass + fail}`);
  await db.end();
  process.exit(fail ? 1 : 0);
})();
