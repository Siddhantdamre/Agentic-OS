#!/usr/bin/env node
'use strict';
/**
 * RLS COVERAGE — is there any way for the application role to read another
 * tenant's rows that does not go through a table policy?
 *
 * Migrations 028, 037 and 043 each closed a table that an audit of pg_class
 * found had no wall around it. Each of those audits looked at TABLES. This one
 * found a view: `outcome_lift`, owned by the superuser `darex`, readable by
 * `darex_app`, returning `org_id` and per-tenant statistics. A view runs with
 * its owner's rights unless it is `security_invoker`, and a superuser is exempt
 * from row-level security, so the tenant tables' policies did not apply:
 *
 *   as org A:  SELECT * FROM outcome_lift   ->  org A's row AND org B's row
 *
 * Migration 207 (and 047 in the repo this was first written for) fixed it. This asserts it stays fixed, and asserts the rule it
 * violated rather than the one instance:
 *
 *   1. every view the application role can read is security_invoker
 *   2. no materialised view is readable (they cannot carry RLS at all)
 *   3. every table with an org_id has RLS enabled, FORCED, and a policy
 *   4. the application role is not a superuser and does not bypass RLS
 *   5. every SECURITY DEFINER function pins its search_path, and the application
 *      role cannot create objects in `public` to hijack one that does not
 *   6. the actual attack, run as the application role: two tenants, one view
 *
 * Runs at the database layer as the real roles. No HTTP, no LLM tokens.
 *
 * Usage: node infra/scripts/check-rls-coverage.js
 * Exit:  0 = no path around the policies, 1 = one exists
 */
const path = require('path');
// (this repo has no env loader; DB_* come from the environment)

let Client;
try { Client = require('pg').Client; }
catch {
  try { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }
  catch { Client = require(path.join(__dirname, '../../services/workflows/node_modules/pg')).Client; }
}

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };
const info = (m) => console.log(`  [INFO] ${m}`);

const base = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'darex',
};
const su = new Client({
  ...base,
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
});

(async () => {
  await su.connect();
  console.log('\n### RLS COVERAGE (nothing reads a tenant table around its policy)\n');

  // ── 4. The role ─────────────────────────────────────────────────────────
  const role = (await su.query(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'darex_app'`)).rows[0];
  role && !role.rolsuper && !role.rolbypassrls
    ? ok('darex_app is neither a superuser nor BYPASSRLS')
    : no('darex_app is neither a superuser nor BYPASSRLS', JSON.stringify(role));

  // ── 1 + 2. Views ────────────────────────────────────────────────────────
  console.log('\n1. Views and materialised views');
  const rels = (await su.query(`
    SELECT c.relkind, c.relname, pg_get_userbyid(c.relowner) AS owner,
           COALESCE('security_invoker=true' = ANY (c.reloptions), FALSE) AS invoker,
           has_table_privilege('darex_app', c.oid, 'SELECT') AS app_can_read
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
     ORDER BY c.relname`)).rows;
  const views = rels.filter((r) => r.relkind === 'v');
  const matviews = rels.filter((r) => r.relkind === 'm');
  const exposed = views.filter((v) => v.app_can_read && !v.invoker);
  exposed.length === 0
    ? ok(`every readable view is security_invoker`, `${views.length} view(s): ${views.map((v) => v.relname).join(', ') || 'none'}`)
    : no('every readable view is security_invoker',
      `${exposed.map((v) => `${v.relname} (owner ${v.owner})`).join(', ')} read tenant tables with the OWNER's rights and bypass RLS`);
  const mv = matviews.filter((m) => m.app_can_read);
  mv.length === 0
    ? ok('no materialised view is readable by the application role')
    : no('no materialised view is readable by the application role', mv.map((m) => m.relname).join(', '));

  // ── 3. Tables ───────────────────────────────────────────────────────────
  console.log('\n2. Every table with an org_id');
  const gaps = (await su.query(`
    SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
           (SELECT COUNT(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
            OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname))
     ORDER BY c.relname`)).rows;
  const total = (await su.query(`
    SELECT COUNT(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'`)).rows[0].n;
  gaps.length === 0
    ? ok(`RLS enabled, FORCED and with a policy on all ${total} tables that carry an org_id`)
    : no('RLS enabled, FORCED and with a policy on every table that carries an org_id',
      gaps.map((g) => `${g.relname}(${g.enabled ? '' : 'no-rls,'}${g.forced ? '' : 'not-forced,'}${g.policies}pol)`).join(' '));

  // ── 5. SECURITY DEFINER functions ───────────────────────────────────────
  console.log('\n3. SECURITY DEFINER functions');
  const unpinned = (await su.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
     ORDER BY 1`)).rows.map((r) => r.proname);
  unpinned.length === 0
    ? ok('every SECURITY DEFINER function pins its search_path')
    : no('every SECURITY DEFINER function pins its search_path', unpinned.join(', '));
  const canCreate = (await su.query(`SELECT has_schema_privilege('darex_app', 'public', 'CREATE') AS c`)).rows[0].c;
  !canCreate
    ? ok('darex_app cannot create objects in schema public',
      'an injected statement cannot plant a function for a SECURITY DEFINER function to run as the superuser')
    : no('darex_app cannot create objects in schema public',
      'it can, so injected SQL can shadow a function that a superuser-owned SECURITY DEFINER function then calls');

  // ── The reader role: fail closed for new tables ─────────────────────────
  console.log('\n4. The model-SQL reader role (darex_sql_reader)');
  const hasReader = (await su.query(`SELECT 1 FROM pg_roles WHERE rolname = 'darex_sql_reader'`)).rowCount === 1;
  if (!hasReader) {
    no('the reader role darex_sql_reader exists', 'apply migration 207_sql_reader_role.sql — model-written SQL would otherwise run with the full application role');
  } else {
  const WITHHELD_WHOLE = ['org_sql_connections'];
  const ungranted = (await su.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND NOT has_any_column_privilege('darex_sql_reader', c.oid, 'SELECT')
     ORDER BY 1`)).rows.map((r) => r.relname).filter((t) => !WITHHELD_WHOLE.includes(t));
  ungranted.length === 0
    ? ok('every tenant table is readable by the reader role or withheld on purpose', `withheld: ${WITHHELD_WHOLE.join(', ')}`)
    : no('every tenant table is readable by the reader role or withheld on purpose',
      `${ungranted.join(', ')} — invisible to model SQL until a migration runs GRANT SELECT ON <table> TO darex_sql_reader (or lists it as withheld in 207 and here)`);
  const doors = (await su.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname = 'public' AND has_function_privilege('darex_sql_reader', p.oid, 'EXECUTE')
     ORDER BY 1`)).rows.map((r) => r.proname);
  doors.length === 0
    ? ok('the reader role can execute no SECURITY DEFINER function')
    : no('the reader role can execute no SECURITY DEFINER function',
      `${doors.join(', ')} — REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC and GRANT it to darex, darex_app explicitly`);
  // A NEW column in an ALREADY-GRANTED table is readable the moment it exists, so a new credential
  // column leaks to model SQL until someone withholds it. Fail on any credential-looking name the
  // reader can read. If one is genuinely harmless, list it here with the reason.
  const HARMLESS_CREDENTIAL_LOOKING = [
  'tool_invocations.args_hash',       // digest of a tool call's arguments, for de-duplication
  'visitor_company_intent.ip_hash',   // salted hash of a visitor's IP, not a credential
];
  const credCols = (await su.query(`
    SELECT c.table_name || '.' || c.column_name AS col FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND (c.column_name ~* '(password|secret|token|api_?key|credential|private_?key|hash|refresh|bearer|authorization)' OR c.column_name = 'meta')
       AND c.column_name !~* '(_tokens$|^tokens$|token_limit|token_count|content_hash$|prompt_hash$|question_hash$|subject_hash$|_at$)'
       AND has_column_privilege('darex_sql_reader', format('public.%I', c.table_name), c.column_name, 'SELECT')
     ORDER BY 1`)).rows.map((r) => r.col).filter((c) => !HARMLESS_CREDENTIAL_LOOKING.includes(c));
  credCols.length === 0
    ? ok('no credential-looking column is readable by the reader role')
    : no('no credential-looking column is readable by the reader role',
      `${credCols.join(', ')} — withhold it from darex_sql_reader (column-level GRANT list in a new migration) or add it to HARMLESS_CREDENTIAL_LOOKING with a reason`);
  const sc = (await su.query(`SELECT has_function_privilege('darex_sql_reader', 'pg_catalog.set_config(text,text,boolean)', 'EXECUTE') AS c`)).rows[0].c;
  !sc ? ok('the reader role cannot call set_config') : no('the reader role cannot call set_config', 'EXECUTE is still granted to PUBLIC');
  const writes = (await su.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v')
       AND (has_table_privilege('darex_sql_reader', c.oid, 'INSERT') OR has_table_privilege('darex_sql_reader', c.oid, 'UPDATE')
         OR has_table_privilege('darex_sql_reader', c.oid, 'DELETE') OR has_table_privilege('darex_sql_reader', c.oid, 'TRUNCATE'))`)).rows;
  writes.length === 0 ? ok('the reader role holds no write privilege on any table') : no('the reader role holds no write privilege', writes.map((r) => r.relname).join(', '));

  }

  // ── 6. The attack itself ────────────────────────────────────────────────
  console.log('\n5. The attack, as the application role');
  const hasView = (await su.query(`SELECT to_regclass('public.outcome_lift') AS r`)).rows[0].r;
  if (!hasView) {
    info('this schema has no outcome_lift view, so the live view attack has nothing to run against; rule 1 above fails the build for any view that is not security_invoker');
    await su.end();
  } else {
  const stamp = Date.now();
  const mkOrg = async (tag) => (await su.query(
    `INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`RLS Cover ${tag} ${stamp}`, `rls-cover-${tag}-${stamp}`])).rows[0].id;
  const A = await mkOrg('a');
  const B = await mkOrg('b');
  const app = new Client({
    ...base,
    user: process.env.DB_USER || 'darex_app',
    password: process.env.DB_PASSWORD || process.env.APP_DB_PASSWORD || 'darex_app_dev_secret',
  });
  try {
    for (const [org, n] of [[A, 2], [B, 5]]) {
      for (let i = 0; i < n; i++) {
        await su.query(
          `INSERT INTO agent_actions (org_id, action_kind, source_table, source_id, occurred_at)
           VALUES ($1, 'reply_sent', 't', $2, now())`, [org, `s${i}`]);
      }
      const ev = (await su.query(
        `INSERT INTO outcome_events (org_id, outcome_kind, occurred_at, source_table, source_id)
         VALUES ($1, 'customer_replied', now(), 't', 'o') RETURNING id`, [org])).rows[0].id;
      const act = (await su.query(`SELECT id FROM agent_actions WHERE org_id = $1 LIMIT 1`, [org])).rows[0].id;
      await su.query(
        `INSERT INTO action_outcomes (org_id, action_id, outcome_id, method, strength, latency_seconds, window_seconds)
         VALUES ($1, $2, $3, 'direct_reply', 'strong', 1, 1)`, [org, act, ev]);
    }
    await app.connect();
    await app.query(`SELECT set_config('app.current_org_id', $1, false)`, [A]);
    const seen = (await app.query(`SELECT DISTINCT org_id FROM outcome_lift`)).rows.map((r) => r.org_id);
    seen.length === 1 && seen[0] === A
      ? ok('outcome_lift, unfiltered, returns only the caller\'s org')
      : no('outcome_lift, unfiltered, returns only the caller\'s org', `saw ${seen.length} org(s): ${seen.map((s) => (s === A ? 'own' : s === B ? 'OTHER TENANT' : s)).join(',')}`);

    await app.query('RESET app.current_org_id');
    const bare = (await app.query(`SELECT COUNT(*)::int AS n FROM outcome_lift`)).rows[0].n;
    bare === 0
      ? ok('with no org context the view returns nothing (fails closed)')
      : no('with no org context the view returns nothing (fails closed)', `${bare} rows`);
  } finally {
    await app.end().catch(() => {});
    await su.query('DELETE FROM orgs WHERE id = ANY($1)', [[A, B]]).catch((e) => console.log('cleanup:', e.message));
    await su.end();
  }
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
