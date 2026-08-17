#!/usr/bin/env node
/**
 * END-TO-END: a real inbound message becomes a stored conversation.
 *
 * This is the chain a production Chatwoot inbox actually drives:
 *   register org -> signed webhook (?org_id=) -> org resolution -> RLS write
 *   -> conversation + message rows -> visible in the conversations feed.
 *
 * WHY THIS EXISTS ALONGSIDE check-phase3.js
 * check-phase3 reads an org id from a `darex_org_id` cookie that the auth flow
 * no longer sets (it was removed because a client-supplied org id must never be
 * trusted). It therefore posts an empty org_id and fails at resolution — a
 * stale test, not a broken product. This exercises the same path the documented
 * per-tenant webhook URL uses: `/api/webhooks/chatwoot?org_id=<uuid>`.
 *
 * Usage: node infra/scripts/check-e2e-inbound.js
 */

// NOTE: 127.0.0.1, never 'localhost'. Node resolves localhost to IPv6 ::1 first;
// Docker publishes on [::] but that path resets the connection, producing
// intermittent ECONNRESET / "fetch failed" that looks like random flakiness.
// curl hides this by falling back to IPv4 — Node's fetch and pg do not.
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

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const stamp = Date.now();
const email = `e2e_${stamp}@example.com`;
const password = `Pw-${stamp}-Aa1!`;
const contact = `+9199${String(stamp).slice(-8)}`;

/** Sign exactly the bytes we send — HMAC is over the raw body. */
function signed(bodyString) {
  const sig = crypto.createHmac('sha256', SECRET).update(bodyString).digest('hex');
  return { 'Content-Type': 'application/json', 'x-chatwoot-signature': `sha256=${sig}` };
}

async function main() {
  console.log('\n=== END-TO-END: inbound message -> stored conversation ===\n');
  await db.connect();

  // 1. A real tenant, created through the real registration endpoint.
  console.log('1. Register a tenant');
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const regBody = await reg.json().catch(() => ({}));
  reg.status === 200 && regBody.orgId
    ? ok('org provisioned', regBody.orgId.slice(0, 8) + '…')
    : no('org provisioned', `HTTP ${reg.status} ${JSON.stringify(regBody).slice(0, 120)}`);
  const orgId = regBody.orgId;
  if (!orgId) throw new Error('cannot continue without an org');

  // Provision a PER-ORG webhook secret. Upstream (correctly) stopped trusting a
  // bare ?org_id=: the global CHATWOOT_WEBHOOK_SECRET is shared by every tenant,
  // so org_id alone would let anyone holding it target another org by guessing
  // ids. Resolution now requires ?token= matching this org's own secret.
  const orgToken = `orgsecret-${stamp}`;
  await db.query(
    `UPDATE orgs SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('webhook_secret', $2::text) WHERE id = $1`,
    [orgId, orgToken]
  );

  const orgRow = await db.query(`SELECT status FROM orgs WHERE id = $1`, [orgId]);
  orgRow.rows[0]?.status === 'active'
    ? ok('org is active (required by webhook org resolution)')
    : no('org is active', `status=${orgRow.rows[0]?.status}`);

  // 2. Inbound webhook, exactly as a per-tenant Chatwoot URL would send it.
  console.log('\n2. Inbound webhook (signed, per-tenant URL)');
  const payload = {
    event: 'message_created',
    message_type: 'incoming',
    content: 'Hi, is the 2BHK on Linking Road still available?',
    id: stamp,
    conversation: { id: stamp % 100000, inbox_id: (stamp % 900000) + 1000 },
    sender: { phone_number: contact, name: 'E2E Buyer' },
    account: { id: (stamp % 800000) + 2000 },
  };
  const body = JSON.stringify(payload);
  const res = await fetch(`${BASE}/api/webhooks/chatwoot?org_id=${orgId}&token=${orgToken}`, {
    method: 'POST',
    headers: signed(body),
    body,
  });
  const out = await res.json().catch(() => ({}));
  res.status === 200
    ? ok('webhook accepted', `HTTP 200`)
    : no('webhook accepted', `HTTP ${res.status} ${JSON.stringify(out).slice(0, 160)}`);

  // 3. Did it actually land in the database, scoped to this org?
  console.log('\n3. Persistence under RLS');
  await new Promise((r) => setTimeout(r, 1500));
  const convs = await db.query(
    `SELECT id, status FROM conversations WHERE org_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [orgId]
  );
  convs.rows.length > 0
    ? ok('conversation row created', `${convs.rows.length} row(s)`)
    : no('conversation row created', 'none found');

  const msgs = await db.query(
    `SELECT role, content FROM messages WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId]
  );
  const inbound = msgs.rows.find((m) => m.content.includes('Linking Road'));
  inbound
    ? ok('inbound message stored verbatim', `role=${inbound.role}`)
    : no('inbound message stored verbatim', JSON.stringify(msgs.rows).slice(0, 140));

  // 4. Cross-tenant safety: nothing leaked into another org.
  console.log('\n4. Tenant isolation');
  const leak = await db.query(
    `SELECT COUNT(*)::int AS n FROM messages WHERE org_id <> $1 AND content LIKE '%Linking Road%'`,
    [orgId]
  );
  leak.rows[0].n === 0
    ? ok('message is not visible under any other org')
    : no('message is not visible under any other org', `${leak.rows[0].n} leaked`);

  // 5. Unsigned delivery must still be refused after all of the above.
  console.log('\n5. Signature enforcement still active');
  const unsigned = await fetch(`${BASE}/api/webhooks/chatwoot?org_id=${orgId}&token=${orgToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  unsigned.status === 401 || unsigned.status === 403
    ? ok('unsigned webhook rejected', `HTTP ${unsigned.status}`)
    : no('unsigned webhook rejected', `HTTP ${unsigned.status}`);

  // 6. Cleanup
  console.log('\n6. Cleanup');
  await db.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  ok('tenant removed');

  console.log('\n--- Summary ---');
  const total = pass + fail;
  console.log(fail === 0 ? `  ALL CHECKS PASSED (${pass}/${total})\n` : `  ${fail} of ${total} CHECKS FAILED\n`);
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nE2E error:', err.message);
  try { await db.end(); } catch {}
  process.exit(1);
});
