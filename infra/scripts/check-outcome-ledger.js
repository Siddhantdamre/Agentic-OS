#!/usr/bin/env node
/**
 * Outcome Ledger verification (migration 022).
 *
 * Seeds a scenario whose correct answer is known by construction, runs the real
 * attribution path against a live database, and asserts the exact numbers.
 * Anything looser would not catch the failure mode that matters: a ledger that
 * still returns plausible-looking figures after the logic silently breaks.
 *
 * Also proves the three properties a buyer's security review will ask about:
 *   - RLS isolation      (org B's data is invisible to org A)
 *   - idempotency        (re-running changes no number)
 *   - honest reporting   (no holdout => lift is NULL, never 0)
 *
 * Usage:
 *   node infra/scripts/check-outcome-ledger.js
 *   DB_NAME=darex_ledger_test node infra/scripts/check-outcome-ledger.js
 */

// NOTE: 127.0.0.1, never 'localhost'. Node resolves localhost to IPv6 ::1 first;
// Docker publishes on [::] but that path resets the connection, producing
// intermittent ECONNRESET / "fetch failed" that looks like random flakiness.
// curl hides this by falling back to IPv4 — Node's fetch and pg do not.
const path = require('path');

let Client;
try {
  Client = require('pg').Client;
} catch {
  Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const {
  runOutcomeLedger,
  readOutcomeLift,
  closeOutcomeLedgerPool,
} = require(path.join(__dirname, '../../services/workflows/dist/activities/outcome-ledger.js'));

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };
const eq = (m, actual, expected) =>
  actual === expected ? ok(m, `${actual}`) : no(m, `expected ${expected}, got ${actual}`);

// Superuser connection: seeding crosses orgs deliberately, which RLS forbids.
// The ledger itself runs on darex_app under RLS — that is what is being tested.
const admin = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const T0 = new Date('2026-03-01T12:00:00Z');
const at = (mins) => new Date(T0.getTime() + mins * 60_000).toISOString();

// The INGEST window (SINCE..UNTIL) is deliberately wider than the ATTRIBUTION
// window (ATTRIBUTION_WINDOW_SECONDS). Otherwise a late outcome is filtered out
// before attribution ever sees it, and the window rule — the thing that stops
// the ledger crediting a reply that arrived two days later — goes untested.
const SINCE = new Date(T0.getTime() - 60 * 60_000).toISOString();
const UNTIL = new Date(T0.getTime() + 48 * 60 * 60_000).toISOString();
const ATTRIBUTION_WINDOW_SECONDS = 24 * 60 * 60;

const TAG = `ledger-check-${Date.now()}`;

async function seedOrg(label) {
  const org = await admin.query(
    `INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id`,
    [`${TAG} ${label}`, `${TAG}-${label}`.toLowerCase()]
  );
  return org.rows[0].id;
}

async function seedConversation(orgId, suffix) {
  const res = await admin.query(
    `INSERT INTO conversations (org_id, status, metadata)
     VALUES ($1, 'open', $2::jsonb) RETURNING id`,
    [orgId, JSON.stringify({ tag: TAG, suffix })]
  );
  return res.rows[0].id;
}

async function seedMessage(orgId, convId, role, content, whenIso) {
  const res = await admin.query(
    `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz) RETURNING id`,
    [orgId, convId, role, content, whenIso]
  );
  return res.rows[0].id;
}

async function main() {
  console.log('\n=== Outcome Ledger — Verification (migration 022) ===\n');
  await admin.connect();

  // ── Schema present ──────────────────────────────────────────────────────
  console.log('1. Schema');
  for (const t of ['agent_actions', 'outcome_events', 'action_outcomes']) {
    const r = await admin.query(`SELECT to_regclass($1) AS t`, [t]);
    r.rows[0].t ? ok(`table ${t} exists`) : no(`table ${t} exists`, 'run migrate.js');
  }
  const v = await admin.query(`SELECT to_regclass('outcome_lift') AS t`);
  v.rows[0].t ? ok('view outcome_lift exists') : no('view outcome_lift exists');

  // RLS must be FORCED, or the app role could read across tenants.
  const rls = await admin.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('agent_actions','outcome_events','action_outcomes')`
  );
  const allForced = rls.rows.length === 3 && rls.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity);
  allForced ? ok('RLS enabled AND forced on all 3 tables') : no('RLS enabled AND forced', JSON.stringify(rls.rows));

  // ── Seed a scenario with a known answer ─────────────────────────────────
  console.log('\n2. Seed scenario');
  const orgA = await seedOrg('orgA');
  const orgB = await seedOrg('orgB');

  //  conv1: agent replies, customer replies 5 min later  -> strong direct_reply
  const c1 = await seedConversation(orgA, 'c1');
  await seedMessage(orgA, c1, 'assistant', 'Hello, how can I help?', at(0));
  await seedMessage(orgA, c1, 'user', 'Yes please, tell me more', at(5));

  //  conv2: agent replies, silence                       -> unattributed
  const c2 = await seedConversation(orgA, 'c2');
  await seedMessage(orgA, c2, 'assistant', 'Following up on your enquiry', at(0));

  //  conv3: agent replies, customer replies 40h later    -> outside 24h window
  const c3 = await seedConversation(orgA, 'c3');
  await seedMessage(orgA, c3, 'assistant', 'Are you still interested?', at(0));
  await seedMessage(orgA, c3, 'user', 'Sorry for the delay', at(40 * 60));

  //  org B: its own traffic, must never appear in org A's ledger
  const cb = await seedConversation(orgB, 'cb');
  await seedMessage(orgB, cb, 'assistant', 'Other tenant message', at(0));
  await seedMessage(orgB, cb, 'user', 'Other tenant reply', at(3));

  ok('seeded 2 orgs, 4 conversations, 7 messages');

  // ── Run the ledger for org A ────────────────────────────────────────────
  console.log('\n3. Attribution (org A, 48h ingest / 24h attribution window)');
  const run = await runOutcomeLedger({
    orgId: orgA,
    since: SINCE,
    until: UNTIL,
    windowSeconds: ATTRIBUTION_WINDOW_SECONDS,
  });

  eq('agent actions ingested', run.actionsIngested, 3);
  // Both customer replies are ingested — including the 40h-late one, which
  // attribution must then reject on its own merits below.
  eq('outcome events ingested', run.outcomesIngested, 2);
  eq('attribution edges written', run.edgesWritten, 1);
  eq('actions with an outcome', run.summary.attributedActions, 1);
  eq('actions with NO outcome (kept in denominator)', run.summary.unattributedActions, 2);
  eq('strong-strength edges', run.summary.byStrength.strong, 1);

  // 1 of 3 actions attributed. A ledger reporting 100% here would be counting
  // only the actions that worked.
  const rate = run.summary.attributionRate;
  Math.abs(rate - 1 / 3) < 1e-9
    ? ok('attribution rate is over ALL actions', `${(rate * 100).toFixed(1)}%`)
    : no('attribution rate is over ALL actions', `expected 33.3%, got ${(rate * 100).toFixed(1)}%`);

  // The 40h-late reply must NOT be credited.
  const outOfWindow = await admin.query(
    `SELECT COUNT(*)::int AS n
       FROM action_outcomes ao
       JOIN agent_actions a ON a.id = ao.action_id
      WHERE ao.org_id = $1 AND a.conversation_id = $2`,
    [orgA, c3]
  );
  eq('out-of-window reply not attributed', outOfWindow.rows[0].n, 0);

  // ── Honest reporting with no control group ──────────────────────────────
  console.log('\n4. Honesty guarantees');
  run.causalComparisonAvailable === false
    ? ok('no holdout => causalComparisonAvailable is false')
    : no('no holdout => causalComparisonAvailable is false', 'claimed a causal comparison without a control');

  const lift = await readOutcomeLift(orgA);
  const nulls = lift.filter((r) => r.liftPp === null).length;
  nulls === lift.length && lift.length > 0
    ? ok('lift is NULL without a holdout (not 0)', `${nulls} row(s)`)
    : no('lift is NULL without a holdout', `${nulls}/${lift.length} rows were NULL`);

  // ── RLS isolation ───────────────────────────────────────────────────────
  console.log('\n5. Multi-tenant isolation');
  const leak = await admin.query(
    `SELECT COUNT(*)::int AS n FROM agent_actions
      WHERE org_id = $1 AND conversation_id IN (SELECT id FROM conversations WHERE org_id = $2)`,
    [orgA, orgB]
  );
  eq("org B's conversations absent from org A's actions", leak.rows[0].n, 0);

  const runB = await runOutcomeLedger({
    orgId: orgB, since: SINCE, until: UNTIL,
    windowSeconds: ATTRIBUTION_WINDOW_SECONDS,
  });
  eq('org B ledger built independently', runB.edgesWritten, 1);

  const crossCheck = await admin.query(
    `SELECT COUNT(*)::int AS n FROM action_outcomes ao
       JOIN agent_actions a ON a.id = ao.action_id
      WHERE ao.org_id <> a.org_id`
  );
  eq('no attribution edge spans two orgs', crossCheck.rows[0].n, 0);

  // ── Idempotency ─────────────────────────────────────────────────────────
  console.log('\n6. Idempotency (re-run must change nothing)');
  const before = await admin.query(
    `SELECT
       (SELECT COUNT(*) FROM agent_actions  WHERE org_id = $1)::int AS a,
       (SELECT COUNT(*) FROM outcome_events WHERE org_id = $1)::int AS o,
       (SELECT COUNT(*) FROM action_outcomes WHERE org_id = $1)::int AS e`,
    [orgA]
  );
  const rerun = await runOutcomeLedger({
    orgId: orgA, since: SINCE, until: UNTIL,
    windowSeconds: ATTRIBUTION_WINDOW_SECONDS,
  });
  const after = await admin.query(
    `SELECT
       (SELECT COUNT(*) FROM agent_actions  WHERE org_id = $1)::int AS a,
       (SELECT COUNT(*) FROM outcome_events WHERE org_id = $1)::int AS o,
       (SELECT COUNT(*) FROM action_outcomes WHERE org_id = $1)::int AS e`,
    [orgA]
  );
  eq('re-run inserts no duplicate actions', after.rows[0].a, before.rows[0].a);
  eq('re-run inserts no duplicate outcomes', after.rows[0].o, before.rows[0].o);
  eq('re-run inserts no duplicate edges', after.rows[0].e, before.rows[0].e);
  eq('re-run reports 0 newly written edges', rerun.edgesWritten, 0);

  // ── Provenance ──────────────────────────────────────────────────────────
  console.log('\n7. Auditability');
  const orphan = await admin.query(
    `SELECT COUNT(*)::int AS n FROM agent_actions
      WHERE org_id = $1 AND (source_table IS NULL OR btrim(source_id) = '')`,
    [orgA]
  );
  eq('every action traces back to a source row', orphan.rows[0].n, 0);

  const ev = await admin.query(
    `SELECT evidence FROM action_outcomes WHERE org_id = $1 LIMIT 1`,
    [orgA]
  );
  const e = ev.rows[0]?.evidence || {};
  e.selection === 'last_touch' && typeof e.candidateActions === 'number'
    ? ok('edge carries evidence for audit', JSON.stringify(e).slice(0, 72) + '…')
    : no('edge carries evidence for audit', JSON.stringify(e));

  // ── Lift arithmetic ─────────────────────────────────────────────────────
  // REGRESSION GUARD. Migration 022 computed rates over attributed actions
  // only, so every rate was ~100% and actions that achieved nothing fell into
  // a separate NULL row. Fixed in 023. These assert the arithmetic directly on
  // a scenario whose answer is known, because "looks plausible" is exactly how
  // that bug survived its first review.
  console.log('\n8. Lift arithmetic (denominator + honesty)');
  const orgL = await seedOrg('orgLift');

  // 4 treatment actions, 1 succeeds => 25%.  4 holdout actions, 2 succeed => 50%.
  // Agent is therefore performing WORSE than doing nothing: lift = -25.00pp.
  const mkActions = async (arm, prefix, n) =>
    admin.query(
      `INSERT INTO agent_actions (org_id, action_kind, source_table, source_id, occurred_at, arm)
       SELECT $1, 'reply_sent', 'messages', $2 || g, NOW(), $3 FROM generate_series(1, $4) g`,
      [orgL, prefix, arm, n]
    );
  const mkHit = async (srcAction, srcOutcome) => {
    await admin.query(
      `INSERT INTO outcome_events (org_id, outcome_kind, occurred_at, source_table, source_id)
       VALUES ($1, 'customer_replied', NOW(), 'messages', $2)`,
      [orgL, srcOutcome]
    );
    await admin.query(
      `INSERT INTO action_outcomes (org_id, action_id, outcome_id, method, strength, latency_seconds, window_seconds)
       SELECT $1,
              (SELECT id FROM agent_actions  WHERE org_id = $1 AND source_id = $2),
              (SELECT id FROM outcome_events WHERE org_id = $1 AND source_id = $3),
              'direct_reply', 'strong', 60, 86400`,
      [orgL, srcAction, srcOutcome]
    );
  };

  await mkActions('treatment', 'lt', 4);
  await mkActions('holdout', 'lh', 4);
  await mkHit('lt1', 'lo1');
  await mkHit('lh1', 'lo2');
  await mkHit('lh2', 'lo3');

  const liftRows = await admin.query(
    `SELECT treatment_actions, treatment_hits, treatment_rate_pct,
            holdout_actions, holdout_hits, holdout_rate_pct, lift_pp
       FROM outcome_lift WHERE org_id = $1 AND outcome_kind = 'customer_replied'`,
    [orgL]
  );
  const L = liftRows.rows[0] || {};

  eq('denominator counts ALL treatment actions', Number(L.treatment_actions), 4);
  eq('treatment rate is 25% (not 100%)', Number(L.treatment_rate_pct), 25);
  eq('denominator counts ALL holdout actions', Number(L.holdout_actions), 4);
  eq('holdout rate is 50%', Number(L.holdout_rate_pct), 50);
  // The honesty test: the ledger must be willing to say the agent is losing.
  eq('negative lift is reported honestly', Number(L.lift_pp), -25);

  const nullRows = await admin.query(
    `SELECT COUNT(*)::int AS n FROM outcome_lift WHERE org_id = $1 AND outcome_kind IS NULL`,
    [orgL]
  );
  eq('no phantom NULL-outcome rows', nullRows.rows[0].n, 0);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  console.log('\n9. Cleanup');
  await admin.query(`DELETE FROM orgs WHERE slug LIKE $1`, [`${TAG}%`.toLowerCase()]);
  const left = await admin.query(
    `SELECT COUNT(*)::int AS n FROM agent_actions WHERE org_id IN (SELECT id FROM orgs WHERE slug LIKE $1)`,
    [`${TAG}%`.toLowerCase()]
  );
  eq('test data removed (cascade)', left.rows[0].n, 0);

  console.log('\n--- Summary ---');
  const total = pass + fail;
  console.log(fail === 0 ? `  ALL CHECKS PASSED (${pass}/${total})\n` : `  ${fail} of ${total} CHECKS FAILED\n`);

  await admin.end();
  await closeOutcomeLedgerPool();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nOutcome ledger check error:', err);
  try { await admin.query(`DELETE FROM orgs WHERE slug LIKE $1`, [`${TAG}%`.toLowerCase()]); } catch {}
  try { await admin.end(); } catch {}
  try { await closeOutcomeLedgerPool(); } catch {}
  process.exit(1);
});
