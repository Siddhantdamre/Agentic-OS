import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['query'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

/**
 * Reject anything that is not a single read-only SELECT/WITH.
 * Literals and comments are stripped first so a string cannot hide a write,
 * and so a write keyword inside a quote is not a false positive.
 * Returns an error message, or null when the statement may run.
 */
export function readOnlySqlViolation(rawQuery: unknown): string | null {
  const trimmed = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const lower = trimmed.toLowerCase();
  if (!trimmed || !(lower.startsWith('select') || lower.startsWith('with'))) {
    return 'SQL query is required and must start with SELECT or WITH';
  }
  const stripped = trimmed
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/--[^\n]*\n?/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const withoutTrailing = stripped.trim().replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return 'Security Policy: Only single-statement SELECT or WITH queries are permitted';
  }
  if (/\$\d+/.test(withoutTrailing)) {
    return 'Security Policy: positional parameters ($1, $2) are not allowed';
  }
  // CTE writes (`WITH d AS (DELETE …) SELECT`), set_config (RLS GUC), and
  // catalog helpers (`pg_read_file`, `pg_sleep`) are not reads.
  if (
    /\b(insert|update|delete|drop|alter|truncate|grant|revoke|copy|create|merge|vacuum|call|execute|into)\b/i.test(withoutTrailing) ||
    /\bfor\s+update\b/i.test(withoutTrailing) ||
    /\bfor\s+share\b/i.test(withoutTrailing) ||
    /set_config/i.test(withoutTrailing) ||
    /\bpg_[a-z0-9_]+/i.test(withoutTrailing) ||
    /\bset\s+/i.test(withoutTrailing)
  ) {
    return 'Security Policy: only read-only SELECT queries are permitted';
  }
  return null;
}

async function execute(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const rawQuery = payload.sql || payload.query || '';
  const violation = readOnlySqlViolation(rawQuery);
  if (violation) {
    return { tool: 'database_query', action: 'query', status: 'error' as const, message: violation, data: { reason: 'policy_denied' }, timestamp };
  }
  const trimmed = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const cleanSql = trimmed.replace(/;\s*$/, '');

  try {
    return await withOrgScopedClient(orgId, async (client) => {
      // READ ONLY blocks table writes the keyword filter might miss.
      // statement_timeout must run inside the transaction (SET LOCAL outside one is a no-op).
      await client.query('BEGIN READ ONLY');
      try {
        await client.query(`SET LOCAL statement_timeout = '15000'`);
        const limitedSql = /\blimit\b/i.test(cleanSql) ? cleanSql : `${cleanSql} LIMIT 26`;
        const dbRes = await client.query(limitedSql);
        await client.query('COMMIT');
        const truncated = dbRes.rows.length > 25;
        const rows = dbRes.rows.slice(0, 25);
        return {
          tool: 'database_query',
          action: 'query',
          status: 'executed' as const,
          message: `✅ SQL query executed safely. Returned ${rows.length} rows${truncated ? ' (truncated to 25)' : ''}`,
          data: { rows, totalRows: dbRes.rows.length, truncated },
          timestamp,
        };
      } catch (execErr) {
        await client.query('ROLLBACK').catch((rollbackErr) => {
          console.error('database_query: ROLLBACK failed, connection left in unknown state:', orgId, rollbackErr);
          (client as any)._rollbackFailed = true;
        });
        throw execErr;
      }
    });
  } catch (err: any) {
    return { tool: 'database_query', action: 'query', status: 'error' as const, message: `Database query failed: ${err.message}`, data: null, timestamp };
  }
}

export const databaseQuery: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
