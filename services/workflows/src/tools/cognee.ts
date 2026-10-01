import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';
import { searchCognee, rememberCognee } from '../memory/cognee-client.js';
import { searchHindsight, retainHindsight } from '../memory/hindsight-client.js';

// Same tool covers both memory backends so existing allowlists and gating apply.
const useCognee = () => process.env.USE_COGNEE !== 'false';
const useHindsight = () => process.env.USE_HINDSIGHT !== 'false';

const ACTIONS = ['search', 'remember'] as const;

function riskFor(action: string): ToolRisk {
  return action === 'remember' ? 'draft' : 'read';
}

async function execute(ctx: ToolActionContext) {
  const { action, payload, orgId, timestamp } = ctx;
  // Dataset and org come from the session org on ctx. A model-supplied
  // payload.orgId or payload.dataset is ignored so one tenant cannot
  // read or write another org's graph.
  const normalizedAction = (action || '').toLowerCase();

  if (normalizedAction === 'remember') {
    const text = String(payload?.text || payload?.content || '').trim();
    if (!text) {
      return {
        tool: 'cognee',
        action: 'remember',
        status: 'error' as const,
        message: 'Parameter "text" is required for cognee remember.',
        data: { remembered: false },
        timestamp,
      };
    }

    const sessionId = payload?.sessionId ? String(payload.sessionId) : undefined;
    const [cogneeOk, hindsightOk] = await Promise.all([
      useCognee() ? rememberCognee({ orgId, text, sessionId }) : false,
      useHindsight() ? retainHindsight({ orgId, text, context: 'durable fact saved by an AI employee' }) : false,
    ]);
    const success = cogneeOk || hindsightOk;

    return {
      tool: 'cognee',
      action: 'remember',
      status: (success ? 'executed' : 'error') as 'executed' | 'error',
      message: success
        ? 'Knowledge successfully ingested into organization memory.'
        : 'Failed to ingest knowledge into organization memory.',
      data: {
        remembered: success,
        cognee: cogneeOk,
        hindsight: hindsightOk,
        orgId,
      },
      timestamp,
    };
  }

  // Default: search
  const query = String(payload?.query || '').trim();
  if (!query) {
    return {
      tool: 'cognee',
      action: 'search',
      status: 'error' as const,
      message: 'Parameter "query" is required for cognee search.',
      data: { citations: [] },
      timestamp,
    };
  }

  try {
    const topK = typeof payload?.topK === 'number' ? payload.topK : 8;
    const results = await Promise.allSettled([
      useCognee()
        ? searchCognee({ orgId, query, searchType: payload?.searchType || 'GRAPH_COMPLETION', topK })
        : Promise.resolve([]),
      useHindsight() ? searchHindsight({ orgId, query, topK }) : Promise.resolve([]),
    ]);
    // Fail honestly only when every enabled backend failed.
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    const enabled = Number(useCognee()) + Number(useHindsight());
    if (failed.length > 0 && failed.length === enabled) throw failed[0].reason;
    const merged = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const seen = new Set<string>();
    const citations = merged
      .filter((c) => !seen.has(c.snippet) && !!seen.add(c.snippet))
      .map((c, i) => ({ ...c, id: `G-${i + 1}` }));

    return {
      tool: 'cognee',
      action: 'search',
      status: 'executed' as const,
      message: `Found ${citations.length} graph memory citations.`,
      data: {
        query,
        citations,
        facts: citations.map((c) => c.snippet),
      },
      timestamp,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tool: 'cognee',
      action: 'search',
      status: 'error' as const,
      message: `Cognee search failed: ${message}`,
      data: { query, citations: [], connected: false },
      timestamp,
    };
  }
}

export const cognee: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
