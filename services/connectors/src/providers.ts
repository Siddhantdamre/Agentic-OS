/**
 * Canonical catalog ids ↔ Nango unique_key aliases and connection-id variants.
 * Connection id convention: `{orgId}_{catalogId}` (never `{orgId}_{alias}` as primary).
 *
 * Callers: client.ts (resolveLiveConnection/deleteConnection/proxyRequest),
 * test-connection.ts (NANGO_PING_SPECS), apps/dashboard/lib/nango-server.ts.
 * No existing providers.ts in services/connectors/src (glob confirmed).
 * Does not read/write data files.
 */

export const NANGO_PROVIDER_ALIASES: Record<string, readonly string[]> = {
  whatsapp: ['whatsapp', 'whatsapp-business'],
  gmail: ['gmail', 'google-mail', 'google'],
  'google-calendar': ['google-calendar', 'google'],
  'google-drive': ['google-drive', 'google'],
  'google-docs': ['google-docs', 'google'],
  'google-sheets': ['google-sheets', 'google'],
  'google-slides': ['google-slides', 'google'],
  'google-forms': ['google-forms', 'google'],
  'google-chat': ['google-chat', 'google'],
  'google-meet': ['google-meet', 'google'],
  'google-contacts': ['google-contacts', 'google'],
  'google-tasks': ['google-tasks', 'google'],
  'google-ads': ['google-ads', 'google'],
  'google-analytics': ['google-analytics', 'google'],
  'google-search-console': ['google-search-console', 'google'],
  'google-business-profile': ['google-business-profile', 'google'],
  'google-cloud': ['google-cloud', 'google'],
  'meta-ads': ['meta-ads', 'facebook'],
  hubspot: ['hubspot'],
  stripe: ['stripe'],
  notion: ['notion'],
  slack: ['slack'],
  shopify: ['shopify'],
  zendesk: ['zendesk'],
  intercom: ['intercom'],
  github: ['github'],
  razorpay: ['razorpay'],
};

export function nangoKeysFor(provider: string): string[] {
  const aliases = NANGO_PROVIDER_ALIASES[provider];
  if (aliases) return [...aliases];
  return [provider];
}

export function connectionIdsFor(orgId: string, provider: string): string[] {
  const ids = new Set<string>([`${orgId}_${provider}`]);
  for (const key of nangoKeysFor(provider)) {
    ids.add(`${orgId}_${key}`);
  }
  return [...ids];
}

export function catalogIdFromConnectionId(orgId: string, connectionId: string): string | null {
  const prefix = `${orgId}_`;
  if (!connectionId.startsWith(prefix)) return null;
  const suffix = connectionId.slice(prefix.length);
  if (!suffix) return null;
  for (const [catalogId, aliases] of Object.entries(NANGO_PROVIDER_ALIASES)) {
    if (catalogId === suffix || aliases.includes(suffix)) return catalogId;
  }
  return suffix;
}

export type PingMethod = 'GET' | 'POST';

export interface PingSpec {
  method: PingMethod;
  endpoint: string;
  headers?: Record<string, string>;
  data?: Record<string, unknown>;
}

/** Read-only (or auth.test) endpoints used by the integrations diagnostic. */
export const NANGO_PING_SPECS: Record<string, PingSpec> = {
  gmail: { method: 'GET', endpoint: '/gmail/v1/users/me/profile' },
  'google-calendar': { method: 'GET', endpoint: '/calendar/v3/users/me/calendarList?maxResults=1' },
  'google-drive': { method: 'GET', endpoint: '/drive/v3/about?fields=user,storageQuota' },
  'google-docs': { method: 'GET', endpoint: '/drive/v3/files?pageSize=1&fields=files(id,name,mimeType)' },
  'google-sheets': { method: 'GET', endpoint: '/drive/v3/files?pageSize=1&q=mimeType%3D%27application/vnd.google-apps.spreadsheet%27' },
  'google-slides': { method: 'GET', endpoint: '/drive/v3/files?pageSize=1&q=mimeType%3D%27application/vnd.google-apps.presentation%27' },
  'google-forms': { method: 'GET', endpoint: '/drive/v3/files?pageSize=1&q=mimeType%3D%27application/vnd.google-apps.form%27' },
  'google-contacts': { method: 'GET', endpoint: '/v1/people/me?personFields=names,emailAddresses' },
  'google-tasks': { method: 'GET', endpoint: '/tasks/v1/users/@me/lists' },
  'google-ads': { method: 'GET', endpoint: '/v14/customers:listAccessibleCustomers' },
  'google-analytics': { method: 'GET', endpoint: '/v1beta/accounts' },
  'google-search-console': { method: 'GET', endpoint: '/webmasters/v3/sites' },
  'google-business-profile': { method: 'GET', endpoint: '/v1/accounts' },
  'google-chat': { method: 'GET', endpoint: '/v1/spaces?pageSize=1' },
  'google-meet': { method: 'GET', endpoint: '/v2/conferenceRecords?pageSize=1' },
  'google-cloud': { method: 'GET', endpoint: '/oauth2/v2/userinfo' },
  github: { method: 'GET', endpoint: '/user' },
  slack: { method: 'POST', endpoint: '/auth.test' },
  hubspot: { method: 'GET', endpoint: '/crm/v3/objects/contacts?limit=1' },
  notion: {
    method: 'GET',
    endpoint: '/v1/users/me',
    headers: { 'Notion-Version': '2022-06-28' },
  },
  stripe: { method: 'GET', endpoint: '/v1/balance' },
  shopify: { method: 'GET', endpoint: '/admin/api/2024-01/shop.json' },
  zendesk: { method: 'GET', endpoint: '/api/v2/users/me.json' },
  intercom: { method: 'GET', endpoint: '/me' },
  'meta-ads': { method: 'GET', endpoint: '/me?fields=id,name' },
};
