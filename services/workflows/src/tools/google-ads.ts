import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['fetch_campaign_metrics'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const googleAdsConnId = `${orgId}_google-ads`;
  const googleAdsToken = await getNangoAccessToken(googleAdsConnId, 'google-ads');
  if (googleAdsToken) {
    try {
      const customerId = payload.customerId || process.env.GOOGLE_ADS_CUSTOMER_ID;
      const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
      if (!customerId) {
        return apiError('google-ads', 'fetch_campaign_metrics', timestamp, 'customerId is required (payload or GOOGLE_ADS_CUSTOMER_ID). Token is connected.');
      }
      if (!developerToken) {
        return apiError('google-ads', 'fetch_campaign_metrics', timestamp, 'GOOGLE_ADS_DEVELOPER_TOKEN is not set. Token is connected but Ads API calls cannot run.');
      }
      if (customerId) {
        const gaRes = await fetch(
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
  return notConnected('google-ads', 'fetch_campaign_metrics', timestamp);
}

export const googleAds: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
