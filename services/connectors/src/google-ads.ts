import { NangoConnectorClient } from './client';
import { notConnectedResult } from './types';

export async function getGoogleAdsPerformance(
  client: NangoConnectorClient,
  orgId: string,
  customerId: string
) {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    const honest = notConnectedResult(
      'nango_unconfigured',
      `GOOGLE_ADS_DEVELOPER_TOKEN is not set. Paste a developer token in dashboard env before querying Ads — Darex will not invent performance data.`,
      'google-ads'
    );
    return {
      connected: false as const,
      success: false,
      status: 400,
      message: honest.message,
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
      reason: honest.reason,
      provider: 'google-ads',
    };
  }

  return client.proxyRequest(
    orgId,
    'google-ads',
    `/v14/customers/${customerId}/googleAds:searchStream`,
    'POST',
    {
      query: 'SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign',
    },
    {
      'developer-token': developerToken,
    }
  );
}
