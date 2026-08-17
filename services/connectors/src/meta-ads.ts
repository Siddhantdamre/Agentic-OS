import { NangoConnectorClient } from './client';

export async function getMetaAdsInsights(
  client: NangoConnectorClient,
  orgId: string,
  adAccountId: string
) {
  return client.proxyRequest(
    orgId,
    'meta-ads',
    `/${adAccountId}/insights?fields=impressions,clicks,spend,conversions`,
    'GET'
  );
}
