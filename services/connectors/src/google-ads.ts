import { NangoConnectorClient } from './client';

export async function getGoogleAdsPerformance(
  client: NangoConnectorClient,
  orgId: string,
  customerId: string
) {
  return client.proxyRequest(
    orgId,
    'google-ads',
    `/v14/customers/${customerId}/googleAds:searchStream`,
    'POST',
    {
      query: 'SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros FROM campaign',
    },
    {
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    }
  );
}
