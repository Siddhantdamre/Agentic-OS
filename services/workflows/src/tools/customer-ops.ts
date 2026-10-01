import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['list_open_loops', 'list_at_risk_conversations'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

function isMissingRelation(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  return (
    code === '42P01' ||
    code === '42703' ||
    /does not exist|relation|column/i.test(err instanceof Error ? err.message : String(err))
  );
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

async function listOpenLoops(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const limit = clampLimit(payload.limit, 50, 100);
  const customerIdentifier =
    typeof payload.customerIdentifier === 'string' && payload.customerIdentifier.trim()
      ? payload.customerIdentifier.trim()
      : typeof payload.customer === 'string' && payload.customer.trim()
        ? payload.customer.trim()
        : null;

  try {
    return await withOrgScopedClient(orgId, async (client) => {
      const params: unknown[] = [orgId, limit];
      let sql = `SELECT o.id, o.promise_summary, o.created_at, o.target_check_at AS due_date,
                        o.status, o.customer_identifier, o.obligor, o.confidence,
                        o.conversation_id
                   FROM agent_open_loops o
                  WHERE o.org_id = $1 AND o.status NOT IN ('closed')`;
      if (customerIdentifier) {
        params.push(customerIdentifier);
        sql += ` AND o.customer_identifier ILIKE '%' || $${params.length} || '%'`;
      }
      sql += ` ORDER BY o.target_check_at ASC NULLS LAST, o.created_at DESC LIMIT $2`;

      const res = await client.query(sql, params);
      return {
        tool: 'customer-ops',
        action: 'list_open_loops',
        status: 'executed' as const,
        message:
          res.rows.length === 0
            ? 'No open loops found for this organization.'
            : `Found ${res.rows.length} open loop(s).`,
        data: {
          openLoops: res.rows.map((row) => ({
            id: row.id,
            promiseSummary: row.promise_summary,
            createdAt: row.created_at,
            dueDate: row.due_date,
            status: row.status,
            customerIdentifier: row.customer_identifier,
            obligor: row.obligor,
            confidence: row.confidence,
            conversationId: row.conversation_id,
          })),
          count: res.rows.length,
        },
        timestamp,
      };
    });
  } catch (err: unknown) {
    if (isMissingRelation(err)) {
      return {
        tool: 'customer-ops',
        action: 'list_open_loops',
        status: 'executed' as const,
        message: 'Open loops are not available for this organization (table missing).',
        data: { openLoops: [], count: 0, unavailable: true },
        timestamp,
      };
    }
    return {
      tool: 'customer-ops',
      action: 'list_open_loops',
      status: 'error' as const,
      message: `Failed to list open loops: ${err instanceof Error ? err.message : String(err)}`,
      data: null,
      timestamp,
    };
  }
}

async function listAtRiskConversations(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const limit = clampLimit(payload.limit, 25, 100);

  try {
    return await withOrgScopedClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT id, channel, contact_id, status, customer_operational_state, updated_at
           FROM conversations
          WHERE org_id = $1
            AND updated_at > NOW() - INTERVAL '7 days'
            AND (
              customer_operational_state IN ('at_risk', 'frustrated', 'unresolved', 'escalated')
              OR status = 'needs_attention'
            )
          ORDER BY updated_at DESC
          LIMIT $2`,
        [orgId, limit],
      );
      return {
        tool: 'customer-ops',
        action: 'list_at_risk_conversations',
        status: 'executed' as const,
        message:
          res.rows.length === 0
            ? 'No at-risk conversations found in the last 7 days.'
            : `Found ${res.rows.length} at-risk conversation(s).`,
        data: {
          conversations: res.rows.map((row) => ({
            id: row.id,
            channel: row.channel,
            contactId: row.contact_id,
            status: row.status,
            operationalState: row.customer_operational_state,
            updatedAt: row.updated_at,
          })),
          count: res.rows.length,
        },
        timestamp,
      };
    });
  } catch (err: unknown) {
    if (isMissingRelation(err)) {
      return {
        tool: 'customer-ops',
        action: 'list_at_risk_conversations',
        status: 'executed' as const,
        message: 'At-risk conversation data is not available (schema missing).',
        data: { conversations: [], count: 0, unavailable: true },
        timestamp,
      };
    }
    return {
      tool: 'customer-ops',
      action: 'list_at_risk_conversations',
      status: 'error' as const,
      message: `Failed to list at-risk conversations: ${err instanceof Error ? err.message : String(err)}`,
      data: null,
      timestamp,
    };
  }
}

async function execute(ctx: ToolActionContext) {
  const action = String(ctx.actionName || ctx.action || '').toLowerCase();
  if (action.includes('open_loop') || action.includes('open-loop')) {
    return listOpenLoops(ctx);
  }
  if (action.includes('at_risk') || action.includes('at-risk') || action.includes('atrisk')) {
    return listAtRiskConversations(ctx);
  }
  return {
    tool: 'customer-ops',
    action: ctx.actionName,
    status: 'error' as const,
    message: `Unknown customer-ops action: ${ctx.actionName}`,
    data: null,
    timestamp: ctx.timestamp,
  };
}

export const customerOps: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
