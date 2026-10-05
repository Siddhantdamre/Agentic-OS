import type { PoolClient } from 'pg';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';
import { checkReadOnlySql } from './sql-guard.js';
import { OrgLimiter } from './org-limiter.js';

const ACTIONS = ['query'] as const;

const MAX_ROWS = 25;
const STATEMENT_TIMEOUT_MS = Math.max(1000, parseInt(process.env.SQL_TOOL_TIMEOUT_MS || '10000', 10) || 10000);

/**
 * Concurrent queries per workspace. The worker's pool holds ten connections for
 * every tenant; without a cap one workspace's runaway queries starve the rest
 * (see org-limiter.ts). Three covers an agent's parallel tool calls and a crew's
 * children with room to spare.
 */
const limiter = new OrgLimiter(Math.max(1, parseInt(process.env.SQL_TOOL_MAX_CONCURRENT_PER_ORG || '3', 10) || 3));

/** How long a list of SECURITY DEFINER function names is trusted before it is re-read. */
const SECDEF_TTL_MS = 60 * 1000;
let secdefCache: { at: number; names: string[] } | null = null;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

/**
 * Lexical pre-check only (no database). Returns an error message, or null when
 * the statement may proceed to the READ ONLY transaction and the reader role.
 * Kept under its old name because database-readonly.test.ts and any caller that
 * wants a cheap yes/no import it.
 */
export function readOnlySqlViolation(rawQuery: unknown): string | null {
  const r = checkReadOnlySql(rawQuery);
  return r.ok ? null : `Security Policy: ${r.reason}`;
}

/**
 * Every SECURITY DEFINER function in the live catalog.
 *
 * Those functions bypass RLS by design and the application role can EXECUTE
 * them, so model-written SQL must never be able to call one. Reading the list
 * from pg_proc — instead of keeping a hand-written one in sql-guard.ts — means
 * a helper added by a later migration is refused from the day it exists.
 * Throws if it cannot be read: a guard that cannot see the doors is not a guard.
 */
async function loadSecurityDefinerFunctions(client: PoolClient): Promise<string[]> {
  if (secdefCache && Date.now() - secdefCache.at < SECDEF_TTL_MS) return secdefCache.names;
  const res = await client.query(
    `SELECT DISTINCT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
  );
  const names = res.rows.map((r: { proname: string }) => r.proname);
  secdefCache = { at: Date.now(), names };
  return names;
}

async function execute(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const rawQuery = payload.sql || payload.query || '';
  const refuse = (message: string) =>
    ({ tool: 'database_query', action: 'query', status: 'error' as const, message, data: null, timestamp });

  // The lexical pass needs no database and rejects most attacks outright, so
  // it runs before a pooled connection is spent.
  const early = checkReadOnlySql(rawQuery);
  if (!early.ok) return refuse(`Security Policy: ${early.reason}`);

  const release = limiter.tryAcquire(orgId);
  if (!release) {
    return refuse('database_query is busy: this workspace already has several queries running. Wait for them to finish, then try again.');
  }

  try {
    return await withOrgScopedClient(orgId, async (client) => {
      const guard = checkReadOnlySql(rawQuery, { deniedFunctions: await loadSecurityDefinerFunctions(client) });
      if (!guard.ok) return refuse(`Security Policy: ${guard.reason}`);

      // READ ONLY makes Postgres itself refuse a write, so a spelling the
      // guard did not anticipate still cannot change data. The statement
      // timeout bounds a runaway query; both are transaction-local so the
      // pooled connection is clean for the next tenant.
      await client.query('BEGIN READ ONLY');
      try {
        // The third layer: run as a role that cannot read credential columns,
        // cannot call set_config (which re-points RLS) and cannot call any
        // SECURITY DEFINER function (migration 207). Transaction-local, so the
        // pooled connection is the application role again after ROLLBACK. If the
        // migration has not been applied this throws and the query is refused:
        // a SQL tool with no reader role is not one to fall back to running.
        await client.query('SET LOCAL ROLE darex_sql_reader');
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        // Backslashes are inert only while this is on; pin it rather than trust the default.
        await client.query('SET LOCAL standard_conforming_strings = on');
        // Bound the result inside Postgres instead of trusting the model to
        // write LIMIT — a `limit` inside a string or subquery is not a bound.
        const dbRes = await client.query(`SELECT * FROM (${guard.sql}) AS darex_query LIMIT ${MAX_ROWS + 1}`);
        const truncated = dbRes.rows.length > MAX_ROWS;
        const rows = dbRes.rows.slice(0, MAX_ROWS);
        return {
          tool: 'database_query',
          action: 'query',
          status: 'executed' as const,
          message: `SQL query executed read-only. Returned ${rows.length} rows${truncated ? ` (truncated to ${MAX_ROWS})` : ''}`,
          data: { rows, totalRows: dbRes.rows.length, truncated },
          timestamp,
        };
      } finally {
        // Nothing here is meant to persist, so never COMMIT. If ROLLBACK itself fails the connection
        // is still inside this READ ONLY transaction as the reader role; mark it so the pool
        // helper destroys it instead of handing it to the next tenant.
        await client.query('ROLLBACK').catch((rollbackErr) => {
          console.error('database_query: ROLLBACK failed, connection will be discarded:', orgId, rollbackErr);
          (client as any)._rollbackFailed = true;
        });
      }
    });
  } catch (err: any) {
    if (err?.code === '42501' && /set role|darex_sql_reader/i.test(String(err.message))) {
      // The app role cannot become the reader: migration 207 is half-applied (the GRANT of the
      // role to darex_app is missing). That is an operator problem; do not send the model off
      // to "name the columns" forever.
      console.error('database_query: cannot SET ROLE darex_sql_reader:', err.message);
      return refuse('Database query refused: the SQL reader role is not usable by the application role. Check migration 207_sql_reader_role.sql (GRANT darex_sql_reader TO darex_app).');
    }
    if (err?.code === '42501') {
      // insufficient_privilege: the query named something the reader role is
      // not granted — in practice a credential column, or `SELECT *` on a table
      // that has one. Say what to do, so the model retries with columns rather
      // than telling the customer the database is broken.
      return refuse(`Database query failed: ${err.message}. Some columns (credentials and secrets) are not readable by this tool; select only the specific columns you need.`);
    }
    if (err?.code === '22023' && /darex_sql_reader/.test(String(err.message))) {
      return refuse('Database query refused: the SQL reader role is missing. Apply migration 207_sql_reader_role.sql.');
    }
    return refuse(`Database query failed: ${err.message}`);
  } finally {
    release();
  }
}

export const databaseQuery: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
