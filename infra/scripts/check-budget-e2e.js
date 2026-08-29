#!/usr/bin/env node
'use strict';
/**
 * BUDGET, END TO END — does the gate change what a real conversation costs?
 *
 * check-llm-budget.js proves the meter and the rule against the database.
 * That is not the same as proving the gate is WIRED: every unit in this
 * codebase's history has at some point been correct, tested, and unreachable,
 * because the last inch was missing and every test called the layer below the
 * gap. Four such dead loops were found in one session.
 *
 * So this drives an actual inbound message through the real webhook into the
 * real workflow, with a budget deliberately set to one token, and then asks
 * the model router which model actually ran. Only the spend log can answer
 * that, and it cannot be fooled by a passing unit test.
 *
 * PASS means: the workspace was over budget, the turn still happened, and it
 * happened on the free tier.
 *
 * Usage: node infra/scripts/check-budget-e2e.js
 * Exit:  0 = the gate is wired, 1 = it is not
 */
const path = require('path');
const crypto = require('crypto');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.CHATWOOT_WEBHOOK_SECRET || 'darex-chatwoot-webhook-secret-dev';
const WAIT_MS = 180_000;

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const cfg = (database) => ({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database,
});

const db = new Client(cfg(process.env.DB_NAME || 'darex'));
const litellm = new Client(cfg('litellm'));

const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function signed(body) {
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  return { 'Content-Type': 'application/json', 'x-chatwoot-signature': `sha256=${sig}` };
}

(async () => {
  await db.connect();
  await litellm.connect();
  await litellm.query("SET TIME ZONE 'UTC'");
  console.log('\n=== BUDGET END-TO-END: is the gate actually wired? ===\n');

  let orgId = null;
  try {
    // ── Tenant with an employee and a budget of one token ────────────────────
    console.log('1. A workspace already over its budget');
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `budget_${stamp}@example.com`, password: `Pw-${stamp}-Aa1!` }),
    });
    const regBody = await reg.json().catch(() => ({}));
    orgId = regBody.orgId;
    if (!orgId) throw new Error(`registration failed: HTTP ${reg.status}`);

    const orgToken = `orgsecret-${stamp}`;
    await db.query(
      `UPDATE orgs SET meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('webhook_secret',$2::text) WHERE id=$1`,
      [orgId, orgToken],
    );
    await db.query(
      `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, status)
       VALUES ($1, 'Sarah', 'sales', $2::jsonb, ARRAY['database_query']::text[], 'active')`,
      [orgId, JSON.stringify({ tone: 'concise, factual. Never invent figures.' })],
    );

    // One token allowed, one already spent: over budget before a word is said.
    const today = new Date();
    const day = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    await db.query(
      `INSERT INTO org_llm_budget (org_id, monthly_token_limit, on_exceeded) VALUES ($1, 1, 'degrade')`,
      [orgId],
    );
    await db.query(
      `SELECT record_llm_usage($1::uuid, $2::date, 'seed', 1, 0, 0, 100, 0)`, [orgId, day],
    );
    ok('budget set to 1 token with 100 already used', 'policy: degrade');

    const mark = (await litellm.query(`SELECT NOW() AT TIME ZONE 'UTC' AS t`)).rows[0].t;

    // ── Drive a real conversation ────────────────────────────────────────────
    console.log('\n2. A real inbound message through the real webhook');
    const payload = {
      event: 'message_created',
      message_type: 'incoming',
      content: 'Hello — what are your opening hours?',
      id: stamp,
      conversation: { id: stamp % 100000, inbox_id: (stamp % 900000) + 1000 },
      sender: { phone_number: `+9199${String(stamp).slice(-8)}`, name: 'Budget E2E' },
      account: { id: (stamp % 800000) + 2000 },
    };
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}/api/webhooks/chatwoot?org_id=${orgId}&token=${orgToken}`, {
      method: 'POST', headers: signed(body), body,
    });
    res.status === 200 ? ok('webhook accepted') : no('webhook accepted', `HTTP ${res.status}`);

    // ── Did the gate run? ────────────────────────────────────────────────────
    console.log('\n3. The gate left a record');
    let ev = null;
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      const r = await db.query(
        `SELECT kind, payload FROM work_events
          WHERE org_id = $1 AND kind = 'budget_exceeded' ORDER BY created_at DESC LIMIT 1`,
        [orgId],
      );
      if (r.rows[0]) { ev = r.rows[0]; break; }
      await sleep(3000);
    }
    ev
      ? ok('a budget_exceeded event was recorded', `state=${ev.payload?.state}`)
      : no('a budget_exceeded event was recorded', 'the gate never ran — it is not wired');

    ev && ev.payload?.modelOverride
      ? ok('the gate chose a replacement model', String(ev.payload.modelOverride))
      : no('the gate chose a replacement model', JSON.stringify(ev && ev.payload));

    // ── Which model actually ran? ────────────────────────────────────────────
    console.log('\n4. Which model the router actually used');
    let calls = [];
    const deadline2 = Date.now() + 120_000;
    while (Date.now() < deadline2) {
      const r = await litellm.query(
        `SELECT model, total_tokens, status FROM "LiteLLM_SpendLogs"
          WHERE end_user = $1 AND "startTime" > $2 ORDER BY "startTime"`,
        [orgId, mark],
      );
      if (r.rows.length) { calls = r.rows; break; }
      await sleep(3000);
    }

    calls.length > 0
      ? ok('the turn still happened', `${calls.length} call(s) — degrade must never mean silence`)
      : no('the turn still happened', 'no LLM call was attributed to this workspace');

    const freeOnly = calls.length > 0 && calls.every((c) => /:free/.test(String(c.model)));
    freeOnly
      ? ok('every call ran on the zero-cost tier', calls.map((c) => c.model).join(', '))
      : no('every call ran on the zero-cost tier', calls.map((c) => `${c.model}`).join(', ') || 'none');

    // ── And it is still attributed ───────────────────────────────────────────
    console.log('\n5. A degraded turn is still billed to the right workspace');
    calls.length > 0
      ? ok('all calls carry the tenant', `end_user = ${orgId.slice(0, 8)}…`)
      : no('all calls carry the tenant');
  } finally {
    if (orgId) await db.query(`DELETE FROM orgs WHERE id = $1`, [orgId]).catch(() => {});
    await db.end().catch(() => {});
    await litellm.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  try { await litellm.end(); } catch { /* closed */ }
  process.exit(1);
});
