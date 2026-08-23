#!/usr/bin/env node
'use strict';
/**
 * TENANT REGISTRY ISOLATION — can one tenant see that another exists?
 *
 * Every tenant-scoped table (conversations, messages, org_memory, work_items,
 * reply_edits, knowledge_gaps) had RLS enabled and forced. `orgs` — the table
 * that defines what a tenant IS — had neither, and no policy. As the
 * least-privilege application role, with no session and no org context:
 *
 *   SELECT COUNT(*) FROM orgs;  ->  58
 *
 * Migration 028 closed it. This asserts it stays closed, and — just as
 * important — that closing it did not break the four flows that legitimately
 * touch `orgs` before any org context exists. A policy that breaks signup gets
 * reverted within a day, and then the hole is back permanently.
 *
 * Runs entirely at the database layer as the real application role. No LLM
 * tokens, no HTTP, a couple of seconds.
 *
 * Usage: node infra/scripts/check-orgs-rls.js
 * Exit:  0 = isolated and working, 1 = something regressed
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

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

/** Run a statement as darex_app — the role the dashboard and worker use. */
async function asApp(sql, params = []) {
  await db.query('SET LOCAL ROLE darex_app');
  return db.query(sql, params);
}

(async () => {
  await db.connect();
  console.log('\n### TENANT REGISTRY ISOLATION (orgs)\n');

  // Two orgs owned by this test, so "sees only its own" is a real claim and
  // not an artefact of there happening to be one row.
  const stamp = Date.now();
  const mk = async (n) => (await db.query(
    `INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`RLS Check ${n} ${stamp}`, `rls-check-${n}-${stamp}`],
  )).rows[0].id;
  const orgA = await mk('a');
  const orgB = await mk('b');

  try {
    // ── The wall ────────────────────────────────────────────────────────────
    const decl = await db.query(`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT COUNT(*)::int FROM pg_policies p WHERE p.tablename = 'orgs') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'orgs'`);
    const d = decl.rows[0] || {};
    d.enabled ? ok('RLS is enabled on orgs') : no('RLS is enabled on orgs');
    // FORCE matters on its own: without it the table owner skips the policy,
    // so it reviews as protected and protects nothing.
    d.forced ? ok('RLS is FORCED, so the owner is bound too') : no('RLS is FORCED, so the owner is bound too');
    d.policies >= 1 ? ok('an isolation policy exists', `${d.policies}`) : no('an isolation policy exists');

    await db.query('BEGIN');
    const blind = await asApp('SELECT COUNT(*)::int AS n FROM orgs');
    blind.rows[0].n === 0
      ? ok('with NO org context the app role sees nothing', '0 rows')
      : no('with NO org context the app role sees nothing', `${blind.rows[0].n} rows visible`);
    await db.query('ROLLBACK');

    // The RESET case, which is not the same as "never set". db.ts runs
    // `RESET app.current_org_id` when it releases a pooled client, and after a
    // RESET the GUC is the EMPTY STRING, not NULL. Every policy used to cast
    // it straight to uuid, so the next unscoped query on that recycled
    // connection died with `invalid input syntax for type uuid: ""` instead of
    // returning nothing — an intermittent 500 that got likelier the busier the
    // system was. Migration 029 NULLIFs it. This is the regression test.
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgA]);
    await db.query('RESET app.current_org_id');
    let afterReset = null;
    try {
      afterReset = (await asApp('SELECT COUNT(*)::int AS n FROM orgs')).rows[0].n;
    } catch (e) {
      afterReset = `threw: ${String(e.message).slice(0, 60)}`;
    }
    afterReset === 0
      ? ok('after RESET the context is empty and returns nothing', 'fails closed, does not throw')
      : no('after RESET the context is empty and returns nothing', String(afterReset));
    await db.query('ROLLBACK');

    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgA]);
    const scoped = await asApp('SELECT id FROM orgs');
    const onlyOwn = scoped.rows.length === 1 && scoped.rows[0].id === orgA;
    onlyOwn
      ? ok('with a context set it sees exactly its own row')
      : no('with a context set it sees exactly its own row', `${scoped.rows.length} rows`);

    const neighbour = await asApp('SELECT COUNT(*)::int AS n FROM orgs WHERE id = $1', [orgB]);
    neighbour.rows[0].n === 0
      ? ok('a neighbour org is invisible even when its id is known')
      : no('a neighbour org is invisible even when its id is known');
    await db.query('ROLLBACK');

    // Naming a neighbour explicitly must not write to it either.
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgA]);
    const upd = await asApp(`UPDATE orgs SET name = 'hijacked' WHERE id = $1`, [orgB]);
    upd.rowCount === 0
      ? ok('it cannot UPDATE a neighbour org', '0 rows affected')
      : no('it cannot UPDATE a neighbour org', `${upd.rowCount} rows affected`);
    await db.query('ROLLBACK');

    await db.query('BEGIN');
    let insertError = null;
    try {
      await asApp(`INSERT INTO orgs (name, slug, status) VALUES ('sneak', 'sneak-${stamp}', 'active')`);
    } catch (e) {
      insertError = String(e.message);
    }
    // Report the actual message on failure. "an unscoped insert succeeded" as
    // the only output sent me hunting an RLS bug that turned out to be a
    // quoting mistake in the probe itself.
    if (insertError && /row-level security/i.test(insertError)) {
      ok('a direct INSERT is refused by the policy');
    } else if (insertError) {
      no('a direct INSERT is refused by the policy', `refused for the WRONG reason: ${insertError}`);
    } else {
      no('a direct INSERT is refused by the policy', 'an unscoped insert succeeded');
    }
    await db.query('ROLLBACK');

    // ── The doors ───────────────────────────────────────────────────────────
    // Each of these runs with NO org context, which is the whole point: they
    // exist for the moments before a context can exist.
    await db.query('BEGIN');
    const provisioned = await asApp(`SELECT org_provision($1::text, $2::text) AS id`,
      [`RLS Check provisioned ${stamp}`, `rls-check-prov-${stamp}`]);
    provisioned.rows[0]?.id
      ? ok('signup can still create an org with no context', 'org_provision')
      : no('signup can still create an org with no context');
    await db.query('ROLLBACK');

    await db.query('BEGIN');
    const byId = await asApp(`SELECT resolve_active_org($1::uuid) AS id`, [orgA]);
    byId.rows[0]?.id === orgA
      ? ok('webhook header routing still resolves', 'resolve_active_org')
      : no('webhook header routing still resolves', JSON.stringify(byId.rows[0]));

    // The secret resolver must answer NULL for a wrong secret, not error and
    // not fall through to something else.
    const bySecret = await asApp(`SELECT resolve_org_by_webhook_secret($1) AS id`, ['definitely-not-a-real-secret']);
    bySecret.rows[0]?.id == null
      ? ok('an unknown webhook secret resolves to nothing', 'resolve_org_by_webhook_secret')
      : no('an unknown webhook secret resolves to nothing', 'it matched an org');

    const pair = await asApp(`SELECT org_resolve_by_id_and_secret($1::uuid, $2::text) AS id`, [orgA, 'wrong-token']);
    pair.rows[0]?.id == null
      ? ok('a valid org id with a WRONG token resolves to nothing', 'org_resolve_by_id_and_secret')
      : no('a valid org id with a WRONG token resolves to nothing', 'it matched an org');

    // With more than one active org this must be NULL — otherwise an
    // unroutable webhook would land in some tenant's inbox.
    const sole = await asApp(`SELECT single_active_org_id() AS id`);
    // Count as the RESOLVER role: `SET LOCAL ROLE darex_app` is still in force
    // inside this transaction, and counting orgs as the app role with no
    // context correctly returns 0 — which would make this check report "only
    // 0 active orgs" and quietly skip itself forever.
    await db.query('RESET ROLE');
    const activeCount = (await db.query(`SELECT COUNT(*)::int AS n FROM orgs WHERE status = 'active'`)).rows[0].n;
    if (activeCount > 1) {
      sole.rows[0]?.id == null
        ? ok('the single-org shortcut is OFF on a multi-tenant deployment', `${activeCount} active orgs`)
        : no('the single-org shortcut is OFF on a multi-tenant deployment', 'it picked a tenant');
    } else {
      console.log(`  [ -- ] single-org shortcut not exercised — only ${activeCount} active org on this deployment`);
    }
    await db.query('ROLLBACK');
  } finally {
    // An error thrown mid-transaction leaves the connection aborted, and then
    // the cleanup fails with "current transaction is aborted" — masking the
    // real error with a meaningless one. Always unwind first.
    try { await db.query('ROLLBACK'); } catch { /* nothing open */ }
    try {
      await db.query(`DELETE FROM orgs WHERE slug LIKE 'rls-check-%' OR slug = 'sneak-${stamp}'`);
    } catch (e) {
      console.log(`  [WARN] cleanup failed: ${String(e.message).slice(0, 90)}`);
    }
    await db.end();
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`\n  ERROR: ${e.message}\n`);
  process.exit(1);
});
