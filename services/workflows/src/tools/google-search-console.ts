import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['search_console_sites', 'search_console_query'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gConnId = `${orgId}_google-search-console`;
  let gToken: string | null = null;
  for (const providerKey of ['google-search-console', 'google']) {
    gToken = await getNangoAccessToken(gConnId, providerKey);
    if (gToken) break;
  }
  if (!gToken) return notConnected('google-search-console', actionName, timestamp);

  try {
    if (actionName.includes('query') || actionName.includes('analytics') || actionName.includes('report')) {
      const siteUrl = payload.siteUrl || payload.site;
      if (!siteUrl) return apiError('google-search-console', 'search_console_query', timestamp, 'siteUrl is required (e.g. sc-domain:example.com or https://example.com/).');
      const startDate = payload.startDate || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const endDate = payload.endDate || new Date().toISOString().slice(0, 10);
      const queryRes = await fetchWithTimeout(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, dimensions: payload.dimensions || ['query'], rowLimit: payload.rowLimit || 25 }),
        },
      );
      const queryData = await queryRes.json().catch(() => ({}));
      if (!queryRes.ok) return apiError('google-search-console', 'search_console_query', timestamp, `Search Console query failed: ${queryRes.status}`, queryData);
      return { tool: 'google-search-console', action: 'search_console_query', status: 'executed' as const, message: `Search Console query for ${siteUrl}`, data: queryData, timestamp };
    }
    const sitesRes = await fetchWithTimeout('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    const sitesData = await sitesRes.json().catch(() => ({}));
    if (!sitesRes.ok) return apiError('google-search-console', 'search_console_sites', timestamp, `Search Console sites failed: ${sitesRes.status}`, sitesData);
    return { tool: 'google-search-console', action: 'search_console_sites', status: 'executed' as const, message: `Listed ${sitesData.siteEntry?.length || 0} Search Console sites`, data: { sites: sitesData.siteEntry || [] }, timestamp };
  } catch (e: any) {
    console.error('[google-search-console] API error:', e.message);
    return { tool: 'google-search-console', action: actionName, status: 'error' as const, message: `google-search-console request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleSearchConsole: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
