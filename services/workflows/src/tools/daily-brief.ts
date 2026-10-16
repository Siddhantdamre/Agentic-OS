/**
 * Read-only daily / executive brief from real work_items rows.
 * Never invents a brief — empty org returns an honest empty payload.
 */
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['read', 'query', 'get'] as const;

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

function isMissingTable(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /does not exist|relation/i.test(message);
}

function titleFromMetadata(metadata: unknown, fallback: string): string {
  if (!metadata || typeof metadata !== 'object') return fallback;
  const rec = metadata as Record<string, unknown>;
  const card = rec.card && typeof rec.card === 'object' ? (rec.card as Record<string, unknown>) : rec;
  if (typeof card.title === 'string' && card.title) return card.title;
  if (typeof card.companyName === 'string' && card.companyName) return card.companyName;
  if (typeof card.issue === 'string' && card.issue) return card.issue;
  if (typeof card.label === 'string' && card.label) return card.label;
  if (typeof card.summary === 'string' && card.summary) return card.summary;
  return fallback;
}

function detailFromMetadata(metadata: unknown, status: string): string {
  if (!metadata || typeof metadata !== 'object') return status;
  const rec = metadata as Record<string, unknown>;
  const card = rec.card && typeof rec.card === 'object' ? (rec.card as Record<string, unknown>) : rec;
  if (typeof card.situation === 'string' && card.situation) return card.situation;
  if (typeof card.whyNow === 'string' && card.whyNow) return card.whyNow;
  if (typeof card.summary === 'string' && card.summary) return card.summary;
  return status.replace(/_/g, ' ');
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, n);
}

export interface DailyBriefRow {
  id: string;
  title: string;
  detail: string;
  status: string;
  dueAt: string | null;
}

/** Pure loader used by the chat tool — real rows or honest empty. */
export async function loadDailyBrief(
  orgId: string,
  limit = DEFAULT_LIMIT,
): Promise<{
  exceptions: DailyBriefRow[];
  totalOpen: number;
  handledOvernight: number;
  empty: boolean;
}> {
  return withOrgScopedClient(orgId, async (client) => {
    let exceptions: DailyBriefRow[] = [];
    let totalOpen = 0;
    let handledOvernight = 0;

    try {
      const countRes = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM work_items
          WHERE org_id = $1
            AND status IN ('needs_attention', 'waiting_approval')`,
        [orgId],
      );
      totalOpen = parseInt(String(countRes.rows[0]?.count || '0'), 10) || 0;

      const open = await client.query<{
        id: string;
        type: string;
        status: string;
        due_at: string | null;
        metadata: unknown;
      }>(
        `SELECT id, type, status, due_at, metadata
           FROM work_items
          WHERE org_id = $1
            AND status IN ('needs_attention', 'waiting_approval')
          ORDER BY
            CASE status WHEN 'needs_attention' THEN 0 ELSE 1 END,
            due_at ASC NULLS LAST,
            updated_at DESC
          LIMIT $2`,
        [orgId, limit],
      );
      exceptions = open.rows.map((row) => ({
        id: row.id,
        title: titleFromMetadata(row.metadata, row.type || 'Work item'),
        detail: detailFromMetadata(row.metadata, row.status),
        status: row.status,
        dueAt: row.due_at,
      }));
    } catch (err: unknown) {
      if (!isMissingTable(err)) throw err;
    }

    try {
      const handled = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM work_items
          WHERE org_id = $1
            AND status IN ('done', 'cancelled')
            AND updated_at >= NOW() - INTERVAL '16 hours'`,
        [orgId],
      );
      handledOvernight = parseInt(String(handled.rows[0]?.count || '0'), 10) || 0;
    } catch (err: unknown) {
      if (!isMissingTable(err)) throw err;
    }

    return {
      exceptions,
      totalOpen,
      handledOvernight,
      empty: exceptions.length === 0 && totalOpen === 0,
    };
  });
}

async function execute(ctx: ToolActionContext) {
  const { orgId, timestamp, payload, actionName } = ctx;
  const limit = parseLimit(payload.limit);
  try {
    const brief = await loadDailyBrief(orgId, limit);
    const message = brief.empty
      ? 'No open exceptions in work_items for this org right now.'
      : `Daily brief: ${brief.totalOpen} open exception(s); ${brief.handledOvernight} handled in the last 16 hours.`;
    return {
      tool: 'daily_brief',
      action: actionName || 'read',
      status: 'executed' as const,
      message,
      data: brief,
      timestamp,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tool: 'daily_brief',
      action: actionName || 'read',
      status: 'error' as const,
      message: `Daily brief unavailable: ${message}`,
      data: { exceptions: [], totalOpen: 0, handledOvernight: 0, empty: true },
      timestamp,
    };
  }
}

export const dailyBrief: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
