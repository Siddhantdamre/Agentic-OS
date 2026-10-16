/**
 * Which connector account a chat tool needs before it can read or send.
 * Unknown tools stay on /connectors so the page does not open a dead OAuth id.
 */

export const CONNECTOR_SIGN_IN_IDS = [
  'whatsapp',
  'gmail',
  'google-calendar',
  'google-ads',
  'meta-ads',
  'hubspot',
  'stripe',
  'notion',
  'slack',
  'shopify',
  'zendesk',
  'intercom',
  'github',
  'razorpay',
  'google-drive',
  'google-docs',
  'google-sheets',
  'google-slides',
  'google-forms',
  'google-chat',
  'google-meet',
  'google-contacts',
  'google-tasks',
  'google-analytics',
  'google-search-console',
  'google-business-profile',
  'google-cloud',
  'quickbooks',
  'microsoft-outlook',
  'microsoft-calendar',
  'google-workspace',
  'google',
] as const;

export type ConnectorSignInId = (typeof CONNECTOR_SIGN_IN_IDS)[number];

const ID_SET = new Set<string>(CONNECTOR_SIGN_IN_IDS);

/** Longer prefixes first so google-search-console wins over shorter google keys. */
const TOOL_PROVIDER_PREFIXES: Array<[string, ConnectorSignInId]> = [
  ['google-search-console', 'google-search-console'],
  ['search-console', 'google-search-console'],
  ['google-business-profile', 'google-business-profile'],
  ['business-list', 'google-business-profile'],
  ['google-analytics', 'google-analytics'],
  ['analytics', 'google-analytics'],
  ['google-calendar', 'google-calendar'],
  ['calendar', 'google-calendar'],
  ['google-sheets', 'google-sheets'],
  ['sheets', 'google-sheets'],
  ['google-slides', 'google-slides'],
  ['slides', 'google-slides'],
  ['google-docs', 'google-docs'],
  ['docs', 'google-docs'],
  ['google-drive', 'google-drive'],
  ['drive', 'google-drive'],
  ['google-forms', 'google-forms'],
  ['forms', 'google-forms'],
  ['google-contacts', 'google-contacts'],
  ['contacts', 'google-contacts'],
  ['google-tasks', 'google-tasks'],
  ['tasks', 'google-tasks'],
  ['google-chat', 'google-chat'],
  ['chat', 'google-chat'],
  ['google-meet', 'google-meet'],
  ['meet', 'google-meet'],
  ['google-cloud', 'google-cloud'],
  ['cloud', 'google-cloud'],
  ['google-ads', 'google-ads'],
  ['meta-ads', 'meta-ads'],
  ['gmail', 'gmail'],
  ['whatsapp', 'whatsapp'],
  ['hubspot', 'hubspot'],
  ['stripe', 'stripe'],
  ['notion', 'notion'],
  ['slack', 'slack'],
  ['shopify', 'shopify'],
  ['zendesk', 'zendesk'],
  ['intercom', 'intercom'],
  ['github', 'github'],
  ['razorpay', 'razorpay'],
  ['quickbooks', 'quickbooks'],
  ['quick-books', 'quickbooks'],
  ['outlook-calendar', 'microsoft-calendar'],
  ['microsoft-calendar', 'microsoft-calendar'],
  ['microsoft-outlook', 'microsoft-outlook'],
  ['outlook', 'microsoft-outlook'],
  ['google-workspace', 'google-workspace'],
  ['workspace', 'google-workspace'],
  ['google', 'google'],
];

export function isConnectorSignInId(id: string): id is ConnectorSignInId {
  return ID_SET.has(id);
}

export function providerKeyForTool(raw: string): ConnectorSignInId | null {
  const key = String(raw || '')
    .toLowerCase()
    .replace(/^mcp\.darex\./, '')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .trim();
  if (!key) return null;
  if (isConnectorSignInId(key)) return key;
  for (const [prefix, id] of TOOL_PROVIDER_PREFIXES) {
    if (key === prefix || key.startsWith(`${prefix}-`)) return id;
  }
  return null;
}

export function connectorSignInPath(raw: string): string {
  const id = providerKeyForTool(raw);
  return id ? `/connectors?connect=${encodeURIComponent(id)}` : '/connectors';
}
