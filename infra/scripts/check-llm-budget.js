#!/usr/bin/env node
'use strict';
/**
 * PER-TENANT BUDGET — does the meter tell the truth, and does the gate hold?
 *
 * The failures that matter are asymmetric, so both directions are tested:
 *
 *   NEVER FIRES     one workspace drains the shared pool and the dial reads 0%
 *   FIRES WRONGLY   a paying customer is throttled because of a bad read
 *   LEAKS           one workspace's consumption counts against another's cap
 *   GOES SILENT     the cap is enforced by refusing to answer
 *
 * The last one is the one this product must not do. The whole reason `degrade`
 * is the default is that the previous outage here — balance at zero, 11 of 12
 * conversations unanswered — proved silence is worse than a weaker answer.
 *
 * Usage: node infra/scripts/check-llm-budget.js
 * Exit:  0 = the budget is sound, 1 = it is not
 */
const path = require('path');
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
  user,
  password,
  database: process.env.DB_NAME || 'darex',
});

// The owner, for setup. Superuser, so it bypasses RLS — which is exactly why
// the isolation checks below must NOT use it.
const db = new Client(cfg(
  process.env.DB_RESOLVER_USER || 'darex',
  process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
));

// The role the application actually runs as. Isolation claims are only worth
// anything when asserted through this one.
const app = new Client(cfg(
  process.env.DB_USER || 'darex_app',
  process.env.DB_PASSWORD || 'darex_dev_secret',
));

const stamp = Date.now();
const today = new Date();
const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

async function mkOrg(tag) {
  const r = await db.query(
    `INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id`,
    [`budget-${tag}-${stamp}`, `budget-${tag}-${stamp}`],
  );
  return r.rows[0].id;
}

/** Read the gate exactly as the activity does: as darex_app, with org context. */
async function status(orgId) {
  await app.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
  const r = await app.query(
    `SELECT limit_tokens, used_tokens, on_exceeded, warn_at, period_start
       FROM llm_budget_status($1::uuid)`,
    [orgId],
  );
  return r.rows[0];
}

(async () => {
  await db.connect();
  await app.connect();
  console.log('\n=== PER-TENANT LLM BUDGET ===\n');

  const A = await mkOrg('a');
  const B = await mkOrg('b');

  try {
    // ── 1. The default is not a cage ─────────────────────────────────────────
    console.log('1. A workspace with no budget row is unlimited');
    let s = await status(A);
    s && s.limit_tokens === null
      ? ok('no row means no limit', 'shipping this feature cannot throttle existing workspaces')
      : no('no row means no limit', JSON.stringify(s));
    s && Number(s.used_tokens) === 0
      ? ok('and consumption starts at zero, not null')
      : no('and consumption starts at zero, not null', `${s && s.used_tokens}`);

    // ── 2. The meter counts ──────────────────────────────────────────────────
    console.log('\n2. The meter adds up what a workspace actually used');
    await db.query(`SELECT record_llm_usage($1::uuid, $2::date, 'paid-model', 3, 100, 50, 150, 0)`, [A, day]);
    await db.query(`SELECT record_llm_usage($1::uuid, $2::date, 'free-model', 2, 800, 200, 1000, 1)`, [A, day]);
    s = await status(A);
    Number(s.used_tokens) === 1150
      ? ok('tokens sum across models', '150 paid + 1,000 free = 1,150')
      : no('tokens sum across models', `${s.used_tokens}`);

    console.log('\n3. Re-running the rollup does not inflate anybody');
    await db.query(`SELECT record_llm_usage($1::uuid, $2::date, 'paid-model', 3, 100, 50, 150, 0)`, [A, day]);
    s = await status(A);
    Number(s.used_tokens) === 1150
      ? ok('the upsert assigns, it does not add', 'still 1,150 after a second run')
      : no('the upsert assigns, it does not add', `${s.used_tokens} — a doubling here throttles a paying customer`);

    // ── 4. Isolation ─────────────────────────────────────────────────────────
    console.log('\n4. One workspace\'s consumption is not another\'s');
    await db.query(`SELECT record_llm_usage($1::uuid, $2::date, 'paid-model', 99, 0, 0, 9999999, 0)`, [B, day]);
    s = await status(A);
    Number(s.used_tokens) === 1150
      ? ok('B burning 10M tokens does not move A', 'A still reads 1,150')
      : no('B burning 10M tokens does not move A', `${s.used_tokens}`);

    console.log('\n5. And the meter itself cannot be read across tenants');
    await app.query("SELECT set_config('app.current_org_id', $1, false)", [A]);
    const cross = await app.query(
      `SELECT COUNT(*)::int AS n FROM org_llm_usage_daily WHERE org_id = $1::uuid`, [B],
    );
    cross.rows[0].n === 0
      ? ok('RLS hides B\'s usage rows from A', 'asserted as darex_app, not as the superuser owner')
      : no('RLS hides B\'s usage rows from A', `${cross.rows[0].n} row(s) visible`);

    let raised = false;
    try {
      await app.query(`SELECT * FROM llm_budget_status($1::uuid)`, [B]);
    } catch { raised = true; }
    raised
      ? ok('and the status function refuses a mismatched org', 'a SECURITY DEFINER must repeat the RLS check')
      : no('and the status function refuses a mismatched org', 'it returned data for another tenant');

    // ── 6. The limit ─────────────────────────────────────────────────────────
    console.log('\n6. A limit is honoured, and defaults to degrade');
    await db.query(
      `INSERT INTO org_llm_budget (org_id, monthly_token_limit) VALUES ($1, 1000)`, [A],
    );
    s = await status(A);
    Number(s.limit_tokens) === 1000 && s.on_exceeded === 'degrade'
      ? ok('the limit reads back and the default policy is degrade', 'never silence by default')
      : no('the limit reads back and the default policy is degrade', JSON.stringify(s));
    Number(s.used_tokens) > Number(s.limit_tokens)
      ? ok('A is over its limit', '1,150 of 1,000')
      : no('A is over its limit');

    console.log('\n7. stop is available but must be chosen');
    await db.query(`UPDATE org_llm_budget SET on_exceeded = 'stop' WHERE org_id = $1`, [A]);
    s = await status(A);
    s.on_exceeded === 'stop'
      ? ok('a workspace can opt into a hard ceiling')
      : no('a workspace can opt into a hard ceiling', s.on_exceeded);

    let rejected = false;
    try {
      await db.query(`UPDATE org_llm_budget SET on_exceeded = 'explode' WHERE org_id = $1`, [A]);
    } catch { rejected = true; }
    rejected
      ? ok('an unknown policy is refused by the database', 'not silently treated as one of the two')
      : no('an unknown policy is refused by the database');

    // ── 8. The period ────────────────────────────────────────────────────────
    console.log('\n8. The budget is scoped to this month, not to all time');
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15);
    const lm = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-15`;
    await db.query(`SELECT record_llm_usage($1::uuid, $2::date, 'paid-model', 1, 0, 0, 500000, 0)`, [A, lm]);
    s = await status(A);
    Number(s.used_tokens) === 1150
      ? ok('last month\'s 500,000 tokens do not count against this month', 'a budget that never resets is a ban')
      : no('last month\'s tokens do not count against this month', `${s.used_tokens}`);

    // ── 9. Metering holds no personal data ───────────────────────────────────
    console.log('\n9. The meter holds counts, not conversations');
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'org_llm_usage_daily'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    const contentish = names.filter((n) => /message|content|text|prompt_body|email|phone|name/.test(n));
    contentish.length === 0
      ? ok('no message, content, or contact column', `columns: ${names.join(', ')}`)
      : no('no message, content, or contact column', `found: ${contentish.join(', ')}`);

    // ── 10. Billing webhook RLS (migration 037) ──────────────────────────────
    console.log('\n10. The billing webhook table now has a wall (037)');
    const rls = await db.query(
      `SELECT relrowsecurity AS on, relforcerowsecurity AS forced
         FROM pg_class WHERE relname = 'billing_webhook_events'`,
    );
    rls.rows[0] && rls.rows[0].on && rls.rows[0].forced
      ? ok('RLS is enabled and forced', 'the same gap migration 028 closed on orgs')
      : no('RLS is enabled and forced', JSON.stringify(rls.rows[0]));

    await db.query(
      `INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, org_id, status)
       VALUES ('stripe', $1, 'invoice.paid', $2, 'received')`,
      [`evt-b-${stamp}`, B],
    );
    await app.query("SELECT set_config('app.current_org_id', $1, false)", [A]);
    const bw = await app.query(`SELECT COUNT(*)::int AS n FROM billing_webhook_events`);
    bw.rows[0].n === 0
      ? ok('A cannot read B\'s billing events')
      : no('A cannot read B\'s billing events', `${bw.rows[0].n} visible`);

    await app.query("SELECT set_config('app.current_org_id', $1, false)", [B]);
    const bwB = await app.query(`SELECT COUNT(*)::int AS n FROM billing_webhook_events`);
    bwB.rows[0].n === 1
      ? ok('but B can read its own', 'the wall is not a brick')
      : no('but B can read its own', `${bwB.rows[0].n}`);

    // An unattributed receipt belongs to nobody and must be visible to nobody.
    await db.query(
      `INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, status)
       VALUES ('stripe', $1, 'invoice.paid', 'received')`,
      [`evt-null-${stamp}`],
    );
    await app.query("SELECT set_config('app.current_org_id', $1, false)", [B]);
    const bwNull = await app.query(`SELECT COUNT(*)::int AS n FROM billing_webhook_events`);
    bwNull.rows[0].n === 1
      ? ok('an unattributed receipt is visible to no tenant', 'guessing an owner would be worse')
      : no('an unattributed receipt is visible to no tenant', `${bwNull.rows[0].n}`);
  } finally {
    await db.query(`DELETE FROM billing_webhook_events WHERE provider_event_id LIKE $1`, [`evt-%${stamp}`]);
    await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[A, B]]);
    await db.end().catch(() => {});
    await app.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* already closed */ }
  try { await app.end(); } catch { /* already closed */ }
  process.exit(1);
});
