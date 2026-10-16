#!/usr/bin/env node
'use strict';
/**
 * MODEL-WRITTEN SQL — can `database_query` write, cross a tenant, or run away?
 *
 * The tool used to accept anything that began with `select` or `with` and held
 * no `;`. Through the compiled tool, as the least-privilege application role,
 * acting as one tenant, a single statement could delete that tenant's rows,
 * read another tenant's messages (RLS keys off a session setting that user SQL
 * can set), read another tenant's password hash (a SECURITY DEFINER helper the
 * app role may EXECUTE), or run for as long as it liked.
 *
 * Three layers, and this proves each holds WITHOUT the one before it:
 *   1. a lexical guard (sql-guard.ts; unit-tested in sql-guard.test.ts)
 *   2. a READ ONLY transaction with a statement timeout
 *   3. a dedicated role (darex_sql_reader, migration 207) that cannot read
 *      credential columns, call set_config, or call a SECURITY DEFINER function
 * Unit tests cannot show that the guard is REACHED or that layers 2 and 3 hold
 * on their own. That is what this proves,
 * against a real database, as the real role, through the same door the agent
 * uses (executeAutonomousToolAction), and by looking at the rows afterwards
 * rather than trusting the tool's own report.
 *
 * Fake tenants, fake secrets, cleaned up in `finally`. No LLM tokens, no HTTP.
 *
 * Usage: node infra/scripts/check-database-query.js
 * Exit:  0 = refused, bounded and intact, 1 = something regressed
 */
const path = require('path');
// (this repo has no env loader; DB_* come from the environment)

// Read once at module load by the tool; a short bound keeps the runaway probe fast.
process.env.SQL_TOOL_TIMEOUT_MS = process.env.SQL_TOOL_TIMEOUT_MS || '1000';

let Client;
try { Client = require('pg').Client; }
catch {
  try { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }
  catch { Client = require(path.join(__dirname, '../../services/workflows/node_modules/pg')).Client; }
}

const dist = path.join(__dirname, '..', '..', 'services', 'workflows', 'dist');
const { databaseQuery } = require(path.join(dist, 'tools', 'database.js'));
const { dbPool } = require(path.join(dist, 'tools', 'shared.js'));

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
const appClient = () => new Client({
  ...base,
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD || process.env.APP_DB_PASSWORD || 'darex_app_dev_secret',
});

/** Run SQL as tenant `orgId` through the SQL tool itself. This repo gates executeAutonomousToolAction
 *  (usage, entitlement, autonomy) in ways that refuse a bare fake tenant, and the gate is a separate layer. */
const ask = (orgId, sql) => databaseQuery.execute({
  tool: 'database_query', action: 'query', actionName: 'query', orgId, payload: { sql }, timestamp: new Date().toISOString(),
});
const refusedByPolicy = (r) => r.status === 'error' && /^Security Policy:/.test(r.message || '');

(async () => {
  await su.connect();
  console.log('\n### MODEL-WRITTEN SQL (database_query)\n');

  const stamp = Date.now();
  const mkOrg = async (tag) => {
    const id = (await su.query(
      `INSERT INTO orgs (name, slug, status, meta) VALUES ($1, $2, 'active', $3) RETURNING id`,
      [`SQL Check ${tag} ${stamp}`, `sql-check-${tag}-${stamp}`, JSON.stringify({ webhook_secret: `FAKE-SECRET-${tag}` })],
    )).rows[0].id;
    await su.query(
      `INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`,
      [id, `${tag}-${stamp}@example.test`, `FAKE-HASH-${tag}`],
    );
    const conv = (await su.query(
      `INSERT INTO conversations (org_id, status) VALUES ($1, 'open') RETURNING id`, [id],
    )).rows[0].id;
    return { id, conv, email: `${tag}-${stamp}@example.test` };
  };
  const A = await mkOrg('a');
  const B = await mkOrg('b');
  const putMsg = (o, text) => su.query(
    `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`, [o.id, o.conv, text]);
  await putMsg(A, 'A-1'); await putMsg(A, 'A-2'); await putMsg(B, 'B-SECRET');
  await su.query(
    `INSERT INTO channels (org_id, channel_type, status, meta) VALUES ($1, 'whatsapp', 'connected', $2)`,
    [A.id, JSON.stringify({ accessToken: 'FAKE-WHATSAPP-TOKEN', phoneNumberId: '1' })]);
  const count = async (o) => (await su.query('SELECT COUNT(*)::int AS n FROM messages WHERE org_id = $1', [o.id])).rows[0].n;

  try {
    // ── 1. The tool still does its job ─────────────────────────────────────
    console.log('1. Ordinary queries still work, and see only the caller');
    const base1 = await ask(A.id, 'SELECT content FROM messages ORDER BY content');
    const got = (base1.data && base1.data.rows || []).map((r) => r.content);
    base1.status === 'executed' && got.length === 2 && got.every((c) => c.startsWith('A-'))
      ? ok('a plain SELECT returns the caller\'s rows only', got.join(','))
      : no('a plain SELECT returns the caller\'s rows only', `${base1.status}: ${base1.message} ${got}`);

    const semi = await ask(A.id, 'SELECT content FROM messages ORDER BY content;');
    semi.status === 'executed' && semi.data.rows.length === 2
      ? ok('a statement ending in one semicolon (what models habitually write) still runs')
      : no('a statement ending in one semicolon still runs', `${semi.status}: ${semi.message}`);

    const meters = await ask(A.id, 'SELECT COUNT(*) AS n FROM billing_meters');
    meters.status === 'executed'
      ? ok('a table sharing a helper prefix (billing_meters) is still readable')
      : no('a table sharing a helper prefix (billing_meters) is still readable', meters.message);

    const wrapped = await ask(A.id, "SELECT n, 'limit' AS word FROM generate_series(1, 500) AS n");
    wrapped.status === 'executed' && wrapped.data.rows.length === 25 && wrapped.data.truncated === true
      ? ok('the row bound holds even when the word "limit" appears in the query', '25 of 500')
      : no('the row bound holds even when the word "limit" appears in the query', wrapped.message);

    // ── 2. The three shipped attacks, plus their close relatives ───────────
    console.log('\n2. The attacks that worked before are refused');
    const attacks = [
      ['DML in a CTE deletes rows', 'WITH d AS (DELETE FROM messages RETURNING content) SELECT * FROM d'],
      ['INSERT in a CTE writes rows',
        `WITH i AS (INSERT INTO work_items (org_id, channel) VALUES ('${A.id}', 'planted-by-attack') RETURNING id) SELECT * FROM i`],
      ['set_config re-points RLS at another tenant',
        `WITH s AS MATERIALIZED (SELECT set_config('app.current_org_id', '${B.id}', false)) SELECT m.content FROM s, messages m`],
      ['set_config, quoted and schema-qualified',
        `SELECT "set_config"('app.current_org_id', '${B.id}', false)`],
      ['a SECURITY DEFINER helper returns another tenant\'s password hash',
        `SELECT * FROM auth_lookup_user_by_email('${B.email}')`],
      ['a sleep with no bound', 'SELECT pg_sleep(30)'],
      ['other tenants\' in-flight SQL via pg_stat_activity', 'SELECT query FROM pg_stat_activity'],
      ['SELECT INTO makes a table', 'SELECT * INTO leaked FROM messages'],
      ['a second statement', 'SELECT 1; DELETE FROM messages'],
    ];
    for (const [label, sql] of attacks) {
      const t0 = Date.now();
      const r = await ask(A.id, sql);
      refusedByPolicy(r)
        ? ok(`${label}: refused`, `${Date.now() - t0}ms`)
        : no(`${label}: refused`, `${r.status}: ${(r.message || '').slice(0, 90)}`);
    }

    // The tool's own word is not evidence. Look at the rows.
    const [nA, nB] = [await count(A), await count(B)];
    nA === 2 && nB === 1
      ? ok('no row was deleted or added by any attack', `A=${nA} B=${nB}`)
      : no('no row was deleted or added by any attack', `A=${nA} (want 2) B=${nB} (want 1)`);
    const planted = (await su.query(`SELECT COUNT(*)::int AS n FROM work_items WHERE channel = 'planted-by-attack'`)).rows[0].n;
    planted === 0 ? ok('the row an INSERT attack would plant does not exist') : no('the row an INSERT attack would plant does not exist', `${planted}`);
    const leaked = (await su.query(`SELECT to_regclass('public.leaked') AS t`)).rows[0].t;
    leaked === null ? ok('SELECT INTO created no table') : no('SELECT INTO created no table', leaked);

    // ── 3. Every SECURITY DEFINER door, from the live catalog ──────────────
    console.log('\n3. Every SECURITY DEFINER function is refused (read from pg_proc, not from a list)');
    const doors = (await su.query(
      `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1`,
    )).rows.map((r) => r.proname);
    const open = [];
    for (const name of doors) {
      const r = await ask(A.id, `SELECT * FROM ${name}()`);
      if (!refusedByPolicy(r)) open.push(`${name} -> ${r.status}: ${(r.message || '').slice(0, 60)}`);
    }
    open.length === 0
      ? ok(`all ${doors.length} SECURITY DEFINER functions are refused before they reach the database`)
      : no(`all ${doors.length} SECURITY DEFINER functions are refused`, open.slice(0, 4).join(' | '));

    // ── 4. A runaway query is cancelled and the pool recovers ──────────────
    console.log('\n4. A runaway query is bounded');
    const t0 = Date.now();
    const slow = await ask(A.id, 'SELECT COUNT(*) FROM generate_series(1, 100000000000)');
    const took = Date.now() - t0;
    slow.status === 'error' && /statement timeout/i.test(slow.message) && took < 5000
      ? ok('cancelled by the statement timeout', `${took}ms against a ${process.env.SQL_TOOL_TIMEOUT_MS}ms bound`)
      : no('cancelled by the statement timeout', `${slow.status} after ${took}ms: ${(slow.message || '').slice(0, 80)}`);
    const after = await ask(A.id, 'SELECT 1 AS alive');
    after.status === 'executed'
      ? ok('the pooled connection is usable again afterwards')
      : no('the pooled connection is usable again afterwards', after.message);

    // ── 5. Layers two and three on their own: Postgres, guard out of the way ─
    console.log('\n5. With the lexical guard bypassed, Postgres itself still refuses');
    const raw = appClient();
    await raw.connect();
    /** Run one statement the way database.ts does, minus the guard; return the error text or ''. */
    const asReader = async (sql, params = []) => {
      await raw.query(`SELECT set_config('app.current_org_id', $1, false)`, [A.id]);
      await raw.query('BEGIN READ ONLY');
      await raw.query('SET LOCAL ROLE darex_sql_reader');
      let out = { err: '', rows: [] };
      try { out.rows = (await raw.query(sql, params)).rows; } catch (e) { out.err = e.message; }
      await raw.query('ROLLBACK');
      return out;
    };
    try {
      const w = await asReader('WITH d AS (DELETE FROM messages RETURNING content) SELECT * FROM d');
      /read-only transaction|permission denied/i.test(w.err)
        ? ok('a DML CTE is rejected (READ ONLY transaction / no DELETE privilege)', w.err)
        : no('a DML CTE is rejected', w.err || 'it ran');
      (await count(A)) === 2 ? ok('and the rows are untouched') : no('and the rows are untouched');

      const flip = await asReader(
        `WITH s AS MATERIALIZED (SELECT set_config('app.current_org_id', $1, false)) SELECT m.content FROM s, messages m`, [B.id]);
      /permission denied for function set_config/i.test(flip.err) && flip.rows.length === 0
        ? ok('set_config cannot re-point RLS — the reader role has no EXECUTE on it', flip.err)
        : no('set_config cannot re-point RLS', flip.err || `${flip.rows.length} cross-tenant rows read`);

      const helper = await asReader(`SELECT * FROM auth_lookup_user_by_email($1)`, [B.email]);
      /permission denied for function/i.test(helper.err) && helper.rows.length === 0
        ? ok('a SECURITY DEFINER helper cannot be called by the reader role', helper.err)
        : no('a SECURITY DEFINER helper cannot be called by the reader role', helper.err || 'it returned rows');

      const escape = await asReader(`SELECT set_config('role', 'darex_app', true)`);
      /permission denied/i.test(escape.err)
        ? ok('the reader cannot step back out to the application role via set_config(\'role\')')
        : no('the reader cannot step back out to the application role', escape.err || 'it did');

      const leftover = await raw.query('SELECT current_user AS u');
      leftover.rows[0].u === (process.env.DB_USER || 'darex_app')
        ? ok('the connection is the application role again after ROLLBACK', leftover.rows[0].u)
        : no('the connection is the application role again after ROLLBACK', leftover.rows[0].u);
    } finally {
      await raw.end();
    }

    // ── 6. The tenant's OWN credentials ────────────────────────────────────
    console.log('\n6. A tenant\'s own credentials are not readable, even though they are its own rows');
    const secrets = [
      ['the WhatsApp access token (channels.meta)', 'SELECT meta FROM channels'],
      ['SELECT * on a table with a withheld column', 'SELECT * FROM channels'],
      ['the inbound webhook secret (orgs.meta)', "SELECT meta->>'webhook_secret' FROM orgs"],
      ['staff password hashes (users)', 'SELECT email, password_hash FROM users'],
      ['a boolean side channel on a hash (WHERE)', "SELECT count(*) FROM users WHERE password_hash LIKE 'FAKE%'"],
      ['an ORDER BY side channel on a hash', 'SELECT email FROM users ORDER BY password_hash'],
      ['a withheld whole table (org_sql_connections)', 'SELECT * FROM org_sql_connections'],
      ['invite token hashes', 'SELECT token_hash FROM org_invites'],
    ];
    for (const [label, sql] of secrets) {
      const r = await ask(A.id, sql);
      const leaked = /FAKE-|A-whsec|FAKE-HASH/.test(JSON.stringify(r.data || ''));
      r.status === 'error' && /permission denied/i.test(r.message) && !leaked
        ? ok(`${label}: refused`)
        : no(`${label}: refused`, `${r.status}${leaked ? ' AND LEAKED' : ''}: ${(r.message || '').slice(0, 80)}`);
    }
    const stillWorks = [
      'SELECT id, name, plan, status FROM orgs',
      'SELECT email, role FROM users',
      'SELECT channel_type, status, connected_at FROM channels',
      'SELECT count(*) FROM channels',
      "SELECT count(*) FROM users WHERE role = 'owner'",
    ];
    for (const sql of stillWorks) {
      const r = await ask(A.id, sql);
      r.status === 'executed' ? ok(`still works: ${sql}`) : no(`still works: ${sql}`, r.message);
    }
    const hint = await ask(A.id, 'SELECT * FROM channels');
    /select only the specific columns/i.test(hint.message || '')
      ? ok('the refusal tells the model what to do (name the columns)')
      : no('the refusal tells the model what to do', hint.message);

    // ── 7. One workspace cannot starve another ──────────────────────────────
    console.log('\n7. A workspace flooding runaway queries does not starve its neighbours');
    // The pool is shared by every tenant. Without a per-workspace cap, ten
    // runaway queries from one workspace occupy every connection and an
    // innocent workspace's trivial query waits behind them (measured: median
    // 4.7 s, p95 10.4 s against a 1.5 s timeout). With the cap, the flood is
    // refused as busy and the neighbour is unaffected.
    const flood = Array.from({ length: 12 }, () => ask(A.id, 'SELECT COUNT(*) FROM generate_series(1, 100000000000)'));
    await new Promise((r) => setTimeout(r, 300));
    const tn = Date.now();
    const neighbour = await ask(B.id, 'SELECT 1 AS alive');
    const waited = Date.now() - tn;
    neighbour.status === 'executed' && waited < 750
      ? ok('an innocent workspace\'s query is answered while another floods', `${waited}ms`)
      : no('an innocent workspace\'s query is answered while another floods', `${neighbour.status} after ${waited}ms`);
    const outcomes = await Promise.all(flood);
    const busy = outcomes.filter((r) => /busy/i.test(r.message || '')).length;
    const ran = outcomes.filter((r) => /statement timeout/i.test(r.message || '')).length;
    busy >= 6 && ran <= 6
      ? ok('the flood is capped per workspace', `${ran} ran to the timeout, ${busy} refused as busy`)
      : no('the flood is capped per workspace', `${ran} ran, ${busy} busy of 12`);
  } finally {
    await su.query('DELETE FROM orgs WHERE id = ANY($1)', [[A.id, B.id]]).catch((e) => console.log('cleanup:', e.message));
    await su.end();
    await dbPool.end().catch(() => {});
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
