import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk } from './shared.js';

const ACTIONS = ['search'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { payload, timestamp } = ctx;
  const query = payload.query || payload.q || payload.search;
  if (!query) {
    return { tool: 'web_search', action: 'search', status: 'error' as const, message: 'Search query is required', data: null, timestamp };
  }
  console.log(`[Web Search Tool] Performing live web search via Jina for: "${query}"...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const searchHeaders: Record<string, string> = {
      'Accept': 'application/json',
      'X-Retain-Images': 'none',
    };
    const jinaKey = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
    if (!jinaKey) {
      return apiError('web_search', 'search', timestamp, 'web_search requires JINA_API_KEY. No fake results are returned.', { configured: false });
    }
    searchHeaders['Authorization'] = `Bearer ${jinaKey}`;
    const searchRes = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: searchHeaders,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!searchRes.ok) throw new Error(`Jina Search API failed: ${searchRes.statusText}`);
    const data = await searchRes.json();
    const results = Array.isArray(data.data) ? data.data.slice(0, 5) : [];

    return {
      tool: 'web_search',
      action: 'search',
      status: results.length > 0 ? 'executed' as const : 'error' as const,
      message: results.length > 0
        ? `✅ Found ${results.length} live web search results for "${query}"`
        : `No web search results found for "${query}"`,
      data: { query, results },
      timestamp,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    return { tool: 'web_search', action: 'search', status: 'error' as const, message: `Search failed: ${err.message}`, data: null, timestamp };
  }
}

export const webSearch: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
