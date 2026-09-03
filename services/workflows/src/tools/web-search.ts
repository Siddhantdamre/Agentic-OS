import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';
import { searchWeb } from './search-providers.js';

const ACTIONS = ['search'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

/**
 * Live web search.
 *
 * All provider selection, key handling and fallback lives in
 * `search-providers.ts`. This file used to hold its own copy of the Jina call
 * and therefore its own copy of the 401 — see that module's header.
 *
 * On total failure this reports which providers were tried and why each one
 * did not answer. "Search failed" with no attribution is an outage nobody can
 * act on; "duckduckgo: HTTP 429; wikipedia: timeout" is a fixable one.
 */
async function execute(ctx: ToolActionContext) {
  const { payload, timestamp } = ctx;
  const query = payload.query || payload.q || payload.search;
  if (!query) {
    return {
      tool: 'web_search', action: 'search', status: 'error' as const,
      message: 'Search query is required', data: null, timestamp,
    };
  }

  const limit = Math.min(Math.max(parseInt(String(payload.limit ?? 5), 10) || 5, 1), 10);
  const outcome = await searchWeb(String(query), limit);

  if (outcome.results.length === 0) {
    const tried = outcome.attempts.map((a) => `${a.provider}: ${a.detail}`).join('; ');
    return {
      tool: 'web_search', action: 'search', status: 'error' as const,
      message: `No web results for "${query}". Providers tried — ${tried || 'none'}.`,
      data: { query, results: [], attempts: outcome.attempts },
      timestamp,
    };
  }

  return {
    tool: 'web_search',
    action: 'search',
    status: 'executed' as const,
    message: `Found ${outcome.results.length} live web results for "${query}" via ${outcome.provider}`,
    data: {
      query,
      provider: outcome.provider,
      results: outcome.results,
      attempts: outcome.attempts,
    },
    timestamp,
  };
}

export const webSearch: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
