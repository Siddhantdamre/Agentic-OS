/**
 * Read-only Growth chat tools. Wrap dormant-lead / pipeline / ROI reads that
 * already exist as Temporal activities and tab APIs. Honest empty when tables
 * or data are missing — never fabricate pipeline value.
 */
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['list_dormant_leads', 'list_pipeline_attribution', 'pipeline_roi'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

function isMissingRelation(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  return code === '42P01' || /does not exist|relation|column/i.test(err instanceof Error ? err.message : String(err));
}

async function listDormantLeads(ctx: ToolActionContext) {
  const { orgId, timestamp, payload } = ctx;
  const staleDays = Math.max(1, Number(payload.staleDays) || 180);
  try {
    const leads = await withOrgScopedClient(orgId, async (client) => {
      const conv = await client.query(
        `SELECT DISTINCT ON (c.id)
                COALESCE(c.summary, c.contact_id, 'dormant lead') AS company_name,
                c.updated_at
           FROM conversations c
          WHERE c.org_id = $1
            AND c.updated_at < NOW() - ($2::int || ' days')::interval
          ORDER BY c.id, c.updated_at DESC
          LIMIT 40`,
        [orgId, staleDays],
      );
      let signals: { rows: Array<{ company_name: string; company_domain: string }> } = { rows: [] };
      try {
        signals = await client.query(
          `SELECT company_name, company_domain FROM lead_intent_signals
            WHERE org_id = $1 AND detected_at > NOW() - INTERVAL '14 days'`,
          [orgId],
        );
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
      }
      const fresh = new Set(
        signals.rows.map((r) => String(r.company_domain || r.company_name).toLowerCase()),
      );
      if (fresh.size === 0) return [];
      return conv.rows
        .map((r: { company_name: string; updated_at: string }) => ({
          companyName: r.company_name,
          domain: String(r.company_name).toLowerCase().replace(/\s+/g, ''),
          lastActivity: r.updated_at,
        }))
        .filter((l: { domain: string; companyName: string }) =>
          [...fresh].some((f) => l.domain.includes(f) || f.includes(l.companyName.toLowerCase())),
        );
    });
    return {
      tool: 'growth',
      action: 'list_dormant_leads',
      status: 'executed' as const,
      message:
        leads.length === 0
          ? 'No dormant leads with recent intent signals. Empty result — not fabricated.'
          : `Found ${leads.length} dormant lead(s) with recent intent.`,
      data: { leads, count: leads.length },
      timestamp,
    };
  } catch (err) {
    if (isMissingRelation(err)) {
      return {
        tool: 'growth',
        action: 'list_dormant_leads',
        status: 'executed' as const,
        message: 'Dormant-lead tables unavailable; returning empty.',
        data: { leads: [], count: 0 },
        timestamp,
      };
    }
    return {
      tool: 'growth',
      action: 'list_dormant_leads',
      status: 'error' as const,
      message: err instanceof Error ? err.message : String(err),
      data: null,
      timestamp,
    };
  }
}

async function listPipelineAttribution(ctx: ToolActionContext) {
  const { orgId, timestamp, payload } = ctx;
  const limit = Math.min(Number(payload.limit) || 40, 100);
  try {
    const rows = await withOrgScopedClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT id, opportunity_work_item_id, crm_deal_id, stage, estimated_value_cents, currency, created_at
           FROM growth_pipeline_attribution
          WHERE org_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [orgId, limit],
      );
      return res.rows;
    });
    return {
      tool: 'growth',
      action: 'list_pipeline_attribution',
      status: 'executed' as const,
      message:
        rows.length === 0
          ? 'No pipeline attribution rows for this org.'
          : `Loaded ${rows.length} pipeline attribution row(s).`,
      data: { rows, count: rows.length },
      timestamp,
    };
  } catch (err) {
    if (isMissingRelation(err)) {
      return {
        tool: 'growth',
        action: 'list_pipeline_attribution',
        status: 'executed' as const,
        message: 'growth_pipeline_attribution table not available; returning empty.',
        data: { rows: [], count: 0 },
        timestamp,
      };
    }
    return {
      tool: 'growth',
      action: 'list_pipeline_attribution',
      status: 'error' as const,
      message: err instanceof Error ? err.message : String(err),
      data: null,
      timestamp,
    };
  }
}

async function pipelineRoi(ctx: ToolActionContext) {
  const { orgId, timestamp } = ctx;
  try {
    const pipelineRoi = await withOrgScopedClient(orgId, async (client) => {
      const out: {
        rows: number;
        estimatedValueCents: number;
        byStage: Record<string, number>;
      } = { rows: 0, estimatedValueCents: 0, byStage: {} };
      const roi = await client.query<{ stage: string; n: string; value: string }>(
        `SELECT stage, COUNT(*)::text AS n, COALESCE(SUM(estimated_value_cents), 0)::text AS value
           FROM growth_pipeline_attribution
          WHERE org_id = $1
          GROUP BY stage`,
        [orgId],
      );
      for (const row of roi.rows) {
        const n = parseInt(row.n, 10) || 0;
        const value = parseInt(row.value, 10) || 0;
        out.rows += n;
        out.estimatedValueCents += value;
        out.byStage[row.stage] = value;
      }
      return out;
    });
    return {
      tool: 'growth',
      action: 'pipeline_roi',
      status: 'executed' as const,
      message:
        pipelineRoi.rows === 0
          ? 'No Growth pipeline ROI rows this period.'
          : `Pipeline ROI: ${pipelineRoi.rows} attribution row(s), ${pipelineRoi.estimatedValueCents} cents estimated.`,
      data: { pipelineRoi },
      timestamp,
    };
  } catch (err) {
    if (isMissingRelation(err)) {
      return {
        tool: 'growth',
        action: 'pipeline_roi',
        status: 'executed' as const,
        message: 'growth_pipeline_attribution table not available; returning empty ROI.',
        data: { pipelineRoi: { rows: 0, estimatedValueCents: 0, byStage: {} } },
        timestamp,
      };
    }
    return {
      tool: 'growth',
      action: 'pipeline_roi',
      status: 'error' as const,
      message: err instanceof Error ? err.message : String(err),
      data: null,
      timestamp,
    };
  }
}

async function execute(ctx: ToolActionContext) {
  const action = String(ctx.actionName || '').toLowerCase();
  if (action.includes('dormant')) return listDormantLeads(ctx);
  if (action.includes('attribution')) return listPipelineAttribution(ctx);
  if (action.includes('roi')) return pipelineRoi(ctx);
  return {
    tool: 'growth',
    action: ctx.actionName,
    status: 'error' as const,
    message: `Unknown growth action: ${ctx.actionName}`,
    data: null,
    timestamp: ctx.timestamp,
  };
}

export const growth: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
