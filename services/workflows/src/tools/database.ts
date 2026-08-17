import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['query'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  let rawQuery = payload.sql || payload.query || '';
  let sql = (typeof rawQuery === 'string' && (rawQuery.toLowerCase().trim().startsWith('select') || rawQuery.toLowerCase().trim().startsWith('with'))) ? rawQuery.trim() : null;
  if (!sql) {
    return { tool: 'database_query', action: 'query', status: 'error' as const, message: 'SQL query is required and must start with SELECT or WITH', data: null, timestamp };
  }

  const normalizedSql = sql.toLowerCase().trim();
  if (sql.includes(';') || (!normalizedSql.startsWith('select') && !normalizedSql.startsWith('with'))) {
    return { tool: 'database_query', action: 'query', status: 'error' as const, message: 'Security Policy: Only single-statement SELECT or WITH queries are permitted', data: null, timestamp };
  }

  try {
    return await withOrgScopedClient(orgId, async (client) => {
      await client.query('BEGIN');
      try {
        const limitedSql = /\blimit\b/i.test(sql) ? sql : `${sql} LIMIT 26`;
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
        await client.query('ROLLBACK').catch(() => {});
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
