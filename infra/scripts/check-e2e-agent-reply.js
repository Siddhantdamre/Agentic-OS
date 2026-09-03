#!/usr/bin/env node
/**
 * END-TO-END: inbound message -> agent -> grounding gate -> stored reply.
 *
 * The full production chain, with nothing stubbed:
 *   register tenant -> provision an active AI employee -> signed per-tenant
 *   webhook -> fireInboundAgent -> Temporal WorkItemWorkflow ->
 *   AutonomousAgentWorkflow (adaptive turn budget) -> reply drafted ->
 *   critic + grounding gate -> assistant message persisted under RLS.
 *
 * This is the piece every other test stopped short of. check-e2e-inbound proves
 * the message lands; this proves the agent answers it and that the answer had
 * to pass the safety gates before being stored.
 *
 * Usage: node infra/scripts/check-e2e-agent-reply.js
 */

// NOTE: 127.0.0.1, never 'localhost'. Node resolves localhost to IPv6 ::1 first;
// Docker publishes on [::] but that path resets the connection, producing
// intermittent ECONNRESET / "fetch failed" that looks like random flakiness.
// curl hides this by falling back to IPv4 — Node's fetch and pg do not.
const crypto = require('crypto');
const path = require('path');
const { awaitSubstantiveReply, explainNoReply } = require('./lib/await-reply');

let Client;
try {
  Client = require('pg').Client;
} catch {
  Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.CHATWOOT_WEBHOOK_SECRET || 'darex-chatwoot-webhook-secret-dev';
/** Agent runs are multi-turn LLM calls; free-tier models are slow. */
const REPLY_TIMEOUT_MS = parseInt(process.env.REPLY_TIMEOUT_MS || '180000', 10);

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
const email = `agent_${stamp}@example.com`;
const password = `Pw-${stamp}-Aa1!`;
const orgToken = `orgsecret-${stamp}`;

function signed(body) {
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return { 'Content-Type': 'application/json', 'x-chatwoot-signature': `sha256=${sig}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n=== END-TO-END: inbound -> agent -> gate -> reply ===\n');
  await db.connect();

  // ── 1. Tenant + per-org webhook secret ──────────────────────────────────
  console.log('1. Tenant');
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const regBody = await reg.json().catch(() => ({}));
  const orgId = regBody.orgId;
  orgId ? ok('org provisioned', orgId.slice(0, 8) + '…') : no('org provisioned', `HTTP ${reg.status}`);
  if (!orgId) throw new Error('no org');

  await db.query(
    `UPDATE orgs SET meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('webhook_secret',$2::text) WHERE id=$1`,
    [orgId, orgToken]
  );

  // ── 2. An ACTIVE AI employee ────────────────────────────────────────────
  // Without one the inbound path has nobody to route to and never calls the
  // agent — the message is simply stored. This is also why a freshly
  // registered tenant appears "silent" until an employee is provisioned.
  console.log('\n2. AI employee');
  const emp = await db.query(
    `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, status)
     VALUES ($1, 'Sarah', 'sales', $2::jsonb, ARRAY['database_query']::text[], 'active')
     RETURNING id, status`,
    [orgId, JSON.stringify({ tone: 'concise, factual. Never invent figures.' })]
  );
  emp.rows[0]?.status === 'active'
    ? ok('active employee provisioned', emp.rows[0].id.slice(0, 8) + '…')
    : no('active employee provisioned');

  // ── 3. Inbound message ──────────────────────────────────────────────────
  console.log('\n3. Inbound webhook');
  const payload = {
    event: 'message_created',
    message_type: 'incoming',
    content: 'Hello — what are your opening hours?',
    id: stamp,
    conversation: { id: stamp % 100000, inbox_id: (stamp % 900000) + 1000 },
    sender: { phone_number: `+9199${String(stamp).slice(-8)}`, name: 'E2E Buyer' },
    account: { id: (stamp % 800000) + 2000 },
  };
  const body = JSON.stringify(payload);
  const res = await fetch(`${BASE}/api/webhooks/chatwoot?org_id=${orgId}&token=${orgToken}`, {
    method: 'POST', headers: signed(body), body,
  });
  res.status === 200 ? ok('webhook accepted') : no('webhook accepted', `HTTP ${res.status}`);

  // ── 4. Wait for the AGENT to answer ─────────────────────────────────────
  console.log(`\n4. Agent reply (polling up to ${Math.round(REPLY_TIMEOUT_MS / 1000)}s)`);
  // Waits for a substantive answer. Taking the first assistant row read the
  // agent's interim acknowledgement instead, which carries no facts by design,
  // and then judged the whole reply on it.
  const outcome = await awaitSubstantiveReply({
    query: (sql, params) => db.query(sql, params),
    orgId,
    timeoutMs: REPLY_TIMEOUT_MS,
  });
  const assistant = outcome.reply ? { content: outcome.reply } : null;
  const waited = Math.round(outcome.waitedMs / 1000);
  if (assistant) {
    ok('agent produced a reply', `${waited}s${outcome.sawAck ? ', after an interim ack' : ''}`);
    console.log(`         reply: ${JSON.stringify(assistant.content.slice(0, 140))}`);
  } else {
    no('agent produced a reply', explainNoReply(outcome));
  }

  // ── 5. Did it go through the workflow (not a raw passthrough)? ──────────
  console.log('\n5. Workflow + gate evidence');
  const events = await db.query(
    `SELECT kind FROM work_events WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId]
  ).catch(() => ({ rows: [] }));
  const kinds = events.rows.map((r) => r.kind);
  kinds.length > 0
    ? ok('work events recorded', kinds.join(', ').slice(0, 90))
    : no('work events recorded', 'none — agent may have bypassed WorkItemWorkflow');

  // A blocked/revised reply is equally valid evidence the gate ran.
  const gateRan = kinds.some((k) => ['agent_replied', 'critic_blocked', 'critic_revised', 'needs_attention'].includes(k));
  gateRan
    ? ok('reply passed through the critic/grounding gate')
    : no('reply passed through the critic/grounding gate', kinds.join(',') || 'no events');

  // ── 6. Tenant isolation still holds under agent load ────────────────────
  console.log('\n6. Isolation');
  const leak = await db.query(
    `SELECT COUNT(*)::int AS n FROM messages WHERE org_id <> $1 AND created_at > NOW() - INTERVAL '5 minutes'
       AND content = $2`,
    [orgId, assistant ? assistant.content : '___none___']
  );
  leak.rows[0].n === 0 ? ok('reply not visible to other tenants') : no('reply not visible to other tenants');

  // ── 7. Cleanup ──────────────────────────────────────────────────────────
  console.log('\n7. Cleanup');
  await db.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  ok('tenant removed');

  console.log('\n--- Summary ---');
  const total = pass + fail;
  console.log(fail === 0 ? `  ALL CHECKS PASSED (${pass}/${total})\n` : `  ${fail} of ${total} CHECKS FAILED\n`);
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nE2E agent error:', err.message);
  try { await db.query(`DELETE FROM orgs WHERE id IN (SELECT id FROM orgs WHERE slug LIKE $1)`, [`%${stamp}%`]); } catch {}
  try { await db.end(); } catch {}
  process.exit(1);
});
