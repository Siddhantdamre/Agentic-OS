import test from 'node:test';
import assert from 'node:assert';
import { checkReadOnlySql } from './sql-guard';

/**
 * The guard is the first of two layers. The second — a READ ONLY transaction
 * with a statement timeout — is Postgres's own and is proven against a real
 * database by infra/scripts/check-database-query.js. These tests pin what the
 * FIRST layer must refuse and, just as important, what it must still allow: a
 * guard that blocks ordinary analytics gets switched off within a week.
 */

const refused = (sql: unknown, opts?: Parameters<typeof checkReadOnlySql>[1]) => {
  const r = checkReadOnlySql(sql, opts);
  assert.strictEqual(r.ok, false, `expected refusal for: ${String(sql)}`);
  return r.reason ?? '';
};
const allowed = (sql: string, opts?: Parameters<typeof checkReadOnlySql>[1]) => {
  const r = checkReadOnlySql(sql, opts);
  assert.strictEqual(r.ok, true, `expected acceptance for: ${sql} (${r.reason})`);
};

// ── What must still work ─────────────────────────────────────────────────

test('ordinary analytics are allowed', () => {
  allowed('SELECT COUNT(*) FROM conversations');
  allowed("SELECT status, COUNT(*) AS n FROM work_items WHERE created_at > now() - interval '7 days' GROUP BY status ORDER BY n DESC");
  allowed('WITH recent AS (SELECT * FROM messages WHERE role = \'user\') SELECT COUNT(*) FROM recent');
  allowed('SELECT m.content, c.status FROM messages m JOIN conversations c ON c.id = m.conversation_id');
  allowed('select generate_series(1, 10)');
  allowed('SELECT id FROM orgs FETCH FIRST 5 ROWS ONLY');
});

test('a table that merely shares a helper prefix is readable', () => {
  // billing_meters is an ordinary tenant table. Refusing every mention of
  // "billing_" would lock the agent out of its own org's spend.
  allowed('SELECT soft_limit, hard_limit FROM billing_meters');
  allowed('SELECT * FROM billing_webhook_events');
});

test('forbidden words inside string literals are just text', () => {
  allowed("SELECT * FROM messages WHERE content = 'please delete me; -- and insert into x'");
  allowed("SELECT 'set_config' AS word");
  allowed("SELECT * FROM messages WHERE content LIKE '%pg_sleep%'");
});

test('identifiers that contain a denied word are not the denied word', () => {
  allowed('SELECT updated_at, deleted_flag, insert_count FROM work_items');
  allowed('SELECT "Order" FROM "Weird Table"');
});

test('typed literals written without a space are not E-strings', () => {
  allowed("SELECT date'2026-01-01'");
});

// ── Writes ───────────────────────────────────────────────────────────────

test('a data-modifying CTE is refused, whatever the verb', () => {
  refused('WITH d AS (DELETE FROM messages RETURNING content) SELECT * FROM d');
  refused("WITH i AS (INSERT INTO work_items (org_id) VALUES ('x') RETURNING id) SELECT * FROM i");
  refused("WITH u AS (UPDATE messages SET content = 'x' RETURNING id) SELECT * FROM u");
  refused('WITH m AS (MERGE INTO messages t USING messages s ON t.id = s.id WHEN MATCHED THEN DELETE RETURNING 1) SELECT * FROM m');
});

test('SELECT INTO and row-locking clauses are refused', () => {
  refused('SELECT * INTO stolen FROM messages');
  refused('SELECT * FROM messages FOR UPDATE');
  refused('SELECT * FROM messages FOR NO KEY UPDATE');
});

test('statements that are not queries never reach the database', () => {
  for (const s of ['DROP TABLE messages', 'TRUNCATE messages', 'COPY messages TO PROGRAM \'id\'', 'DO $$ BEGIN END $$',
    'SET ROLE darex', 'EXPLAIN ANALYZE DELETE FROM messages', 'CALL erase_person(1)', 'VACUUM', 'GRANT ALL ON messages TO PUBLIC']) {
    refused(s);
  }
});

// ── The RLS switch ───────────────────────────────────────────────────────

test('set_config is refused however it is spelled', () => {
  const b = '00000000-0000-4000-8000-00000000000b';
  refused(`WITH s AS MATERIALIZED (SELECT set_config('app.current_org_id', '${b}', false)) SELECT m.content FROM s, messages m`);
  refused("SELECT SET_CONFIG('app.current_org_id', 'x', false)");
  refused("SELECT \"set_config\"('app.current_org_id', 'x', false)");
  refused("SELECT \"SET_CONFIG\"('app.current_org_id', 'x', false)");
  refused("SELECT pg_catalog.set_config('app.current_org_id', 'x', false)");
  refused("SELECT public . set_config ( 'a' , 'b' , true )");
  refused("SELECT\nset_config\n(\n'a','b',false)");
});

// ── SECURITY DEFINER doors ───────────────────────────────────────────────

test('platform helper functions are refused when called', () => {
  refused("SELECT * FROM auth_lookup_user_by_email('victim@example.test')");
  refused("SELECT auth_lookup_user_by_id('00000000-0000-4000-8000-000000000001')");
  refused("SELECT billing_lookup_by_provider_customer('stripe', 'cus_1')");
  refused("SELECT resolve_org_by_webhook_secret('s')");
  refused("SELECT org_resolve_by_id_and_secret('00000000-0000-4000-8000-000000000001', 's')");
  refused("SELECT public.\"auth_lookup_user_by_email\" ('x')");
});

test('a SECURITY DEFINER function the guard has never heard of is refused when the catalog names it', () => {
  // record_commitment-style names have no shared prefix. database.ts reads
  // them from pg_proc and passes them here, so a future migration is covered
  // the day it lands.
  const catalog = { deniedFunctions: ['decide_approval', 'erase_person', 'llm_budget_status'] };
  refused("SELECT decide_approval('a', 'b', 'c', 'd', 'e')", catalog);
  refused('SELECT * FROM erase_person(1)', catalog);
  refused("SELECT llm_budget_status('x')", { deniedFunctions: ['LLM_BUDGET_STATUS'] });
});

test('the catalog list only blocks CALLS, so a column with the same name still reads', () => {
  allowed('SELECT llm_budget_status FROM some_table', { deniedFunctions: ['llm_budget_status'] });
});

// ── Functions that run text, read files or wait ──────────────────────────

test('functions that execute SQL text, touch files or sleep are refused', () => {
  refused("SELECT query_to_xml('DELETE FROM messages', true, true, '')");
  refused("SELECT table_to_xml('messages', true, true, '')");
  refused("SELECT cursor_to_xml('c', 1, true, true, '')");
  refused("SELECT * FROM ts_stat('SELECT 1')");
  refused("SELECT * FROM dblink('host=x', 'select 1') AS t(a int)");
  refused("SELECT * FROM crosstab('select 1')");
  refused("SELECT lo_import('/etc/passwd')");
  refused('SELECT pg_sleep(600)');
  refused("SELECT pg_read_file('/etc/passwd')");
  refused('SELECT pg_terminate_backend(pid) FROM pg_stat_activity');
  refused('SELECT query FROM pg_stat_activity');
  refused("SELECT nextval('some_seq')");
});

// ── Ways of hiding a keyword ─────────────────────────────────────────────

test('comments are refused, so a keyword cannot be split or a bound swallowed', () => {
  refused('SELECT 1 -- trailing');
  refused('SELECT 1 /* x */');
  refused('SEL/**/ECT 1');
  refused('SELECT 1 FROM messages WHERE true /* set_config */');
});

test('dollar quoting, positional parameters, backslashes and escape strings are refused', () => {
  refused('SELECT $$delete$$');
  refused('SELECT $tag$ x $tag$');
  refused('SELECT $1');
  refused("SELECT E'\\x64elete'");
  refused("SELECT e'abc'");
  refused("SELECT U&'d\\0061ta'");
  refused('SELECT U&"d\\0061ta" FROM t');
  refused('SELECT \\gexec');
});

test('more than one statement is refused; ONE trailing semicolon is just punctuation', () => {
  refused('SELECT 1; DELETE FROM messages');
  refused('SELECT 1;;');
  refused('SELECT 1; ;');
  refused("SELECT ';'; SELECT 2");
  // Models habitually end a statement with ';'. It must not cost a turn.
  allowed('SELECT count(*) FROM conversations;');
  allowed('SELECT count(*) FROM conversations ;  ');
  allowed("SELECT ';' AS semi");
  // The statement that is run has the semicolon removed, so it can sit in a subquery.
  const r = checkReadOnlySql('SELECT 1;');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sql, 'SELECT 1');
  // A semicolon that only LOOKS trailing because a string is unterminated is still refused.
  refused("SELECT 'abc;");
  refused(';');
});

test('large-object, dblink and crosstab names are refused only when CALLED, so ordinary columns survive', () => {
  allowed('SELECT lo_reason, crosstab_label FROM tickets');
  allowed('SELECT dblink_note FROM notes');
  refused("SELECT lo_import('/etc/passwd')");
  refused("SELECT * FROM dblink('host=x', 'select 1') AS t(a int)");
  refused("SELECT * FROM crosstab('select 1')");
});

test('malformed input fails closed', () => {
  refused("SELECT 'unterminated");
  refused('SELECT "unterminated');
  refused('SELECT "" FROM t');
  refused('SELECT 1\u0000');
  refused('');
  refused('   ');
  refused(undefined);
  refused(null);
  refused(42);
  refused({ sql: 'SELECT 1' });
});

test('the statement must begin with SELECT or WITH', () => {
  refused('EXPLAIN SELECT 1');
  refused('(SELECT 1)');
  refused('VALUES (1)');
  refused('  \n\t delete from messages');
  // Postgres reads a byte >= 0x80 as part of an identifier, so an NBSP is not whitespace to it.
  refused('SELECT\u00a01');
});

test('success returns the trimmed statement and reports why on failure', () => {
  const ok = checkReadOnlySql('   SELECT 1  \n');
  assert.deepStrictEqual(ok, { ok: true, sql: 'SELECT 1' });
  assert.match(refused("SELECT set_config('a','b',false)"), /set_config/);
  assert.match(refused('SELECT 1 -- x'), /comment/);
});
