import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, nangoAuthError, notConnected, resolveGoogleAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = ['fetch_campaign_metrics'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const _gadsAuth = await resolveGoogleAuth(orgId, 'google-ads');
  const googleAdsToken = _gadsAuth.kind === 'connected' ? _gadsAuth.accessToken : null;
  const _gadsAuthErr = _gadsAuth.kind === 'connected' ? null : nangoAuthError('google-ads', 'fetch_campaign_metrics', timestamp, _gadsAuth);
  if (googleAdsToken) {
    try {
      const customerId = payload.customerId || process.env.GOOGLE_ADS_CUSTOMER_ID;
      const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
      if (!customerId) {
        return apiError('google-ads', 'fetch_campaign_metrics', timestamp, 'customerId is required (payload or GOOGLE_ADS_CUSTOMER_ID). Token is connected.');
      }
      if (!developerToken) {
        // catalog_only until developer token — honest notConnected, never fake metrics.
        const path = '/connectors?connect=google-ads';
        return {
          tool: 'google-ads',
          action: 'fetch_campaign_metrics',
          status: 'error' as const,
          message:
            'google-ads is notConnected: GOOGLE_ADS_DEVELOPER_TOKEN is missing. OAuth alone is not enough for live Ads API calls. Set the developer token, then reconnect at ' +
            path +
            '. Do not invent campaign metrics.',
          data: {
            connected: false,
            setupUrl: path,
            missing: 'GOOGLE_ADS_DEVELOPER_TOKEN',
            reason: 'catalog_only_pending_developer_token',
          },
          timestamp,
        };
      }
      if (customerId) {
        const gaRes = await fetchWithTimeout(
          `https://googleads.googleapis.com/v14/customers/${customerId}/googleAds:search`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${googleAdsToken}`,
              'developer-token': developerToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: `SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS`,
            }),
          }
        );
        if (gaRes.ok) {
          const gaData = await gaRes.json();
          return {
            tool: 'google-ads',
            action: 'fetch_campaign_metrics',
            status: 'executed' as const,
            message: `Fetched live Google Ads campaign metrics for customer ${customerId}`,
            data: { results: gaData.results || [] },
            timestamp,
          };
        }
      }
    } catch (e: any) {
      console.error('[Google Ads] API error:', e.message);
    }
  }
  return _gadsAuthErr ?? notConnected('google-ads', 'fetch_campaign_metrics', timestamp);
}

export const googleAds: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
