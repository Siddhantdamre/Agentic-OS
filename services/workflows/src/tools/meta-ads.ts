import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['fetch_campaign_metrics'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const metaAdsConnId = `${orgId}_meta-ads`;
  const metaAdsToken = await getNangoAccessToken(metaAdsConnId, 'meta-ads');
  if (metaAdsToken) {
    try {
      const adAccountId = payload.adAccountId || process.env.META_AD_ACCOUNT_ID;
      if (!adAccountId) {
        return apiError('meta-ads', 'fetch_campaign_metrics', timestamp, 'adAccountId is required (payload or META_AD_ACCOUNT_ID). Token is connected.');
      }
      if (adAccountId) {
        const fields = 'campaign_name,impressions,clicks,ctr,spend,reach';
        const metaRes = await fetch(
          `https://graph.facebook.com/v18.0/${adAccountId}/insights?fields=${fields}&date_preset=last_7d`,
          { headers: { Authorization: `Bearer ${metaAdsToken}` } }
        );
        if (metaRes.ok) {
          const metaData = await metaRes.json();
          return {
            tool: 'meta-ads',
            action: 'fetch_campaign_metrics',
            status: 'executed' as const,
            message: `Fetched live Meta Ads campaign metrics for account ${adAccountId}`,
            data: { campaigns: metaData.data || [], paging: metaData.paging },
            timestamp,
          };
        }
      }
    } catch (e: any) {
      console.error('[Meta Ads] API error:', e.message);
    }
  }
  return notConnected('meta-ads', 'fetch_campaign_metrics', timestamp);
}

export const metaAds: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
