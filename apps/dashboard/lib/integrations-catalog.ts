/**
 * Product catalog for /integrations and /connectors.
 * Fallback seed SOURCE only — `connector_defs` (DB registry) is the system of record.
 * GET /api/integrations reads the registry; this module seeds and remains a
 * compile-time fallback if the table is missing or empty.
 * Callers: app/api/integrations/route.ts, nango-token/route.ts, test/route.ts,
 * lib/connector-registry.ts.
 */

export type IntegrationAuthMode = 'oauth' | 'api_key' | 'byok' | 'service_account';
export type IntegrationExecutorStatus = 'live' | 'catalog_only';

export interface IntegrationField {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  secret?: boolean;
  type?: 'text' | 'password' | 'number' | 'email';
}

export interface IntegrationCatalogItem {
  id: string;
  name: string;
  category: string;
  icon: string;
  desc: string;
  authMode: IntegrationAuthMode;
  extraConnectFields: IntegrationField[];
  extraTestFields: IntegrationField[];
  executorStatus: IntegrationExecutorStatus;
  testable: boolean;
  scopes: string[];
  envVars: Array<{ name: string; desc: string }>;
  webhookEvents: string[];
  operatorHint?: string;
}

export const INTEGRATION_IDS = [
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
] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

const ID_SET = new Set<string>(INTEGRATION_IDS);

export function isIntegrationId(id: string): id is IntegrationId {
  return ID_SET.has(id);
}

const GOOGLE_OAUTH_ENV = [
  { name: 'GOOGLE_CLIENT_ID', desc: 'Google Cloud Console OAuth Client ID (paste into Nango UI)' },
  { name: 'GOOGLE_CLIENT_SECRET', desc: 'Google Cloud Console OAuth Client Secret (paste into Nango UI)' },
];

export const INTEGRATION_CATALOG: IntegrationCatalogItem[] = [
  {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    category: 'Messaging',
    icon: 'MessageSquare',
    desc: 'Meta Cloud API for inbound & outbound WhatsApp customer messaging',
    authMode: 'byok',
    extraConnectFields: [
      { key: 'accessToken', label: 'System User Access Token', placeholder: 'EAAG...', required: true, secret: true, type: 'password' },
      { key: 'phoneNumberId', label: 'Phone Number ID', placeholder: '1045...', required: true },
      { key: 'wabaId', label: 'WhatsApp Business Account ID (optional)', placeholder: '109...', required: false },
    ],
    extraTestFields: [
      { key: 'recipient', label: 'Recipient phone (optional send)', placeholder: '+14155552671', required: false },
      { key: 'text', label: 'Message text (optional send)', placeholder: 'Hello from Darex', required: false },
    ],
    executorStatus: 'live',
    testable: true,
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    envVars: [
      { name: 'META_ACCESS_TOKEN', desc: 'Fallback env token if per-org BYOK is empty (agent path)' },
      { name: 'WHATSAPP_PHONE_NUMBER_ID', desc: 'Fallback phone number id' },
    ],
    webhookEvents: ['messages', 'message_template_status_update'],
    operatorHint: 'Paste a Meta system-user token. Connect is verified against Graph before status becomes Connected. Outbound 401 means rotate the token.',
  },
  {
    id: 'gmail',
    name: 'Gmail / Email',
    category: 'Email',
    icon: 'Mail',
    desc: 'Inbound email triage & outbound response drafting via Gmail API',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [
      { key: 'recipient', label: 'Recipient email (optional send)', placeholder: 'user@example.com', required: false, type: 'email' },
      { key: 'text', label: 'Email content (optional send)', placeholder: 'Hello from Darex', required: false },
    ],
    executorStatus: 'live',
    testable: true,
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: ['message_received'],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    category: 'Calendar',
    icon: 'Calendar',
    desc: 'Real-time slot checking & appointment booking',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [
      { key: 'title', label: 'Event title (optional create)', placeholder: 'Darex strategy call', required: false },
      { key: 'attendeesStr', label: 'Attendee emails, comma separated', placeholder: 'lead@example.com', required: false },
    ],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: ['event_created', 'event_updated'],
  },
  {
    id: 'google-ads',
    name: 'Google Ads',
    category: 'Advertising',
    icon: 'BarChart2',
    desc: 'Search campaign analytics, conversion logging & ROAS metrics',
    authMode: 'oauth',
    extraConnectFields: [
      { key: 'customerId', label: 'Google Ads customer ID (optional, stored on the org)', placeholder: '123-456-7890', required: false },
    ],
    extraTestFields: [
      { key: 'customerId', label: 'Google Ads customer ID', placeholder: '123-456-7890', required: false },
    ],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/adwords'],
    envVars: [...GOOGLE_OAUTH_ENV, { name: 'GOOGLE_ADS_DEVELOPER_TOKEN', desc: 'Google Ads API developer token' }],
    webhookEvents: ['conversion_recorded'],
    operatorHint: 'Needs a real Google OAuth client in Nango plus GOOGLE_ADS_DEVELOPER_TOKEN for metrics.',
  },
  {
    id: 'meta-ads',
    name: 'Meta Ads',
    category: 'Advertising',
    icon: 'Megaphone',
    desc: 'ROAS tracking & Meta ad campaign performance monitoring',
    authMode: 'oauth',
    extraConnectFields: [
      { key: 'adAccountId', label: 'Meta ad account ID (optional)', placeholder: 'act_123456789', required: false },
    ],
    extraTestFields: [
      { key: 'adAccountId', label: 'Meta ad account ID', placeholder: 'act_123456789', required: false },
    ],
    executorStatus: 'live',
    testable: true,
    scopes: ['ads_management', 'ads_read'],
    envVars: [
      { name: 'META_APP_ID', desc: 'Meta App ID (paste into Nango UI)' },
      { name: 'META_APP_SECRET', desc: 'Meta App Secret (paste into Nango UI)' },
      { name: 'META_AD_ACCOUNT_ID', desc: 'Fallback ad account id' },
    ],
    webhookEvents: ['leadgen'],
    operatorHint: 'Paste a real Meta OAuth client ID/secret into the Nango UI at :3003 before the popup can finish.',
  },
  {
    id: 'hubspot',
    name: 'HubSpot CRM',
    category: 'CRM',
    icon: 'Database',
    desc: 'Automatic contact creation, deal stage updates & lead tracking',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [
      { key: 'email', label: 'Contact email (optional create)', placeholder: 'lead@example.com', required: false, type: 'email' },
      { key: 'firstName', label: 'First name', placeholder: 'Alex', required: false },
      { key: 'lastName', label: 'Last name', placeholder: 'Morgan', required: false },
    ],
    executorStatus: 'live',
    testable: true,
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
    envVars: [
      { name: 'HUBSPOT_CLIENT_ID', desc: 'HubSpot app client ID (paste into Nango UI)' },
      { name: 'HUBSPOT_CLIENT_SECRET', desc: 'HubSpot app client secret (paste into Nango UI)' },
    ],
    webhookEvents: ['contact.creation'],
    operatorHint: 'Needs a real HubSpot OAuth client ID in the Nango UI.',
  },
  {
    id: 'stripe',
    name: 'Stripe Payments',
    category: 'Payments',
    icon: 'CreditCard',
    desc: 'Subscription tracking, payment links & customer billing sync',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['read_write'],
    envVars: [
      { name: 'STRIPE_CLIENT_ID', desc: 'Stripe Connect client ID (paste into Nango UI)' },
      { name: 'STRIPE_SECRET_KEY', desc: 'Not stored here — Nango holds the connected account token' },
    ],
    webhookEvents: ['payment_intent.succeeded'],
    operatorHint: 'Needs a real Stripe OAuth client ID in the Nango UI.',
  },
  {
    id: 'notion',
    name: 'Notion Workspace',
    category: 'Knowledge',
    icon: 'BookOpen',
    desc: 'Sync knowledge bases, product docs & team task databases',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['read', 'write'],
    envVars: [
      { name: 'NOTION_CLIENT_ID', desc: 'Notion integration client ID (paste into Nango UI)' },
      { name: 'NOTION_CLIENT_SECRET', desc: 'Notion integration secret (paste into Nango UI)' },
    ],
    webhookEvents: ['page.created'],
    operatorHint: 'Needs a real Notion OAuth client ID in the Nango UI.',
  },
  {
    id: 'slack',
    name: 'Slack Notifications',
    category: 'Messaging',
    icon: 'Slack',
    desc: 'Team alerts, channel notifications & human-handoff triggers',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['chat:write', 'channels:read', 'users:read'],
    envVars: [
      { name: 'SLACK_CLIENT_ID', desc: 'Slack app client ID (paste into Nango UI)' },
      { name: 'SLACK_CLIENT_SECRET', desc: 'Slack app client secret (paste into Nango UI)' },
    ],
    webhookEvents: ['message.channels'],
    operatorHint: 'Needs a real Slack OAuth client ID in the Nango UI.',
  },
  {
    id: 'shopify',
    name: 'Shopify Store',
    category: 'E-Commerce',
    icon: 'ShoppingBag',
    desc: 'Order tracking, inventory queries & customer fulfillment sync',
    authMode: 'oauth',
    extraConnectFields: [
      { key: 'shopDomain', label: 'Shop domain', placeholder: 'my-store.myshopify.com', required: true },
    ],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['read_products', 'read_orders', 'write_orders'],
    envVars: [
      { name: 'SHOPIFY_CLIENT_ID', desc: 'Shopify app client ID (paste into Nango UI)' },
      { name: 'SHOPIFY_CLIENT_SECRET', desc: 'Shopify app secret (paste into Nango UI)' },
    ],
    webhookEvents: ['orders/create'],
    operatorHint: 'Needs a real Shopify OAuth client in Nango plus the shop subdomain for the popup.',
  },
  {
    id: 'zendesk',
    name: 'Zendesk Support',
    category: 'Support',
    icon: 'Headphones',
    desc: 'Helpdesk ticket creation & customer escalation sync',
    authMode: 'oauth',
    extraConnectFields: [
      { key: 'subdomain', label: 'Zendesk subdomain', placeholder: 'mycompany', required: true },
    ],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['read', 'write'],
    envVars: [
      { name: 'ZENDESK_CLIENT_ID', desc: 'Zendesk OAuth client ID (paste into Nango UI)' },
      { name: 'ZENDESK_CLIENT_SECRET', desc: 'Zendesk OAuth secret (paste into Nango UI)' },
    ],
    webhookEvents: ['ticket.created'],
    operatorHint: 'Needs a real Zendesk OAuth client in Nango plus the account subdomain.',
  },
  {
    id: 'intercom',
    name: 'Intercom Inbox',
    category: 'Support',
    icon: 'MessageCircle',
    desc: 'Live customer chat sync & agent assignment',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['read', 'write'],
    envVars: [
      { name: 'INTERCOM_CLIENT_ID', desc: 'Intercom app client ID (paste into Nango UI)' },
      { name: 'INTERCOM_CLIENT_SECRET', desc: 'Intercom app secret (paste into Nango UI)' },
    ],
    webhookEvents: ['conversation.created'],
    operatorHint: 'Needs a real Intercom OAuth client ID in the Nango UI. Agent tools: fetch, reply, create conversation.',
  },
  {
    id: 'github',
    name: 'GitHub Code',
    category: 'Development',
    icon: 'Github',
    desc: 'Repository sync, pull request logs & issue tracking',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['repo', 'read:org'],
    envVars: [
      { name: 'GITHUB_CLIENT_ID', desc: 'GitHub OAuth app client ID (paste into Nango UI)' },
      { name: 'GITHUB_CLIENT_SECRET', desc: 'GitHub OAuth app secret (paste into Nango UI)' },
    ],
    webhookEvents: ['issues', 'pull_request'],
  },
  {
    id: 'razorpay',
    name: 'Razorpay Invoices',
    category: 'Payments',
    icon: 'CreditCard',
    desc: 'Instant payment link generation & invoice status queries',
    authMode: 'api_key',
    extraConnectFields: [
      { key: 'keyId', label: 'Key ID', placeholder: 'rzp_live_...', required: true },
      { key: 'keySecret', label: 'Key Secret', placeholder: '••••', required: true, secret: true, type: 'password' },
    ],
    extraTestFields: [
      { key: 'customerEmail', label: 'Customer email (optional invoice)', placeholder: 'billing@example.com', required: false, type: 'email' },
      { key: 'amountInPaisa', label: 'Amount in paisa (optional invoice)', placeholder: '499900', required: false, type: 'number' },
    ],
    executorStatus: 'live',
    testable: true,
    scopes: ['invoices.write', 'payments.read'],
    envVars: [
      { name: 'RAZORPAY_KEY_ID', desc: 'Fallback env key used by the agent if per-org keys are empty' },
      { name: 'RAZORPAY_KEY_SECRET', desc: 'Fallback env secret' },
    ],
    webhookEvents: ['payment.authorized'],
    operatorHint: 'Not Nango OAuth. Per-org keys are verified into channels.meta; agent tools use those first, then RAZORPAY_KEY_ID/SECRET env.',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'Productivity',
    icon: 'FolderOpen',
    desc: 'Search, read, upload & share files across Google Drive',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/drive'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
  },
  {
    id: 'google-docs',
    name: 'Google Docs',
    category: 'Productivity',
    icon: 'FileText',
    desc: 'Create, read & append content in Google Docs documents',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
  },
  {
    id: 'google-sheets',
    name: 'Google Sheets',
    category: 'Productivity',
    icon: 'Table',
    desc: 'Read, create & append rows in Google Sheets spreadsheets',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
  },
  {
    id: 'google-slides',
    name: 'Google Slides',
    category: 'Productivity',
    icon: 'Presentation',
    desc: 'Create & present slide decks in Google Slides',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/presentations', 'https://www.googleapis.com/auth/drive'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
  },
  {
    id: 'google-forms',
    name: 'Google Forms',
    category: 'Productivity',
    icon: 'FileCheck',
    desc: 'Read & capture form structure and responses',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
  },
  {
    id: 'google-chat',
    name: 'Google Chat',
    category: 'Messaging',
    icon: 'MessageSquare',
    desc: 'Send & receive messages in Google Chat spaces',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/chat.messages', 'https://www.googleapis.com/auth/chat.spaces'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
    operatorHint: 'Needs a real Google OAuth client in Nango. Agent tools: chat_list_spaces, chat_send_message.',
  },
  {
    id: 'google-meet',
    name: 'Google Meet',
    category: 'Meetings',
    icon: 'Video',
    desc: 'Schedule and manage Google Meet video spaces',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/meetings.space.created', 'https://www.googleapis.com/auth/meetings.space.readonly'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
    operatorHint: 'Needs a real Google OAuth client in Nango. Agent tools: meet_create_space, meet_get_space.',
  },
  {
    id: 'google-contacts',
    name: 'Google Contacts',
    category: 'Contacts',
    icon: 'Users',
    desc: 'Sync & query organization contacts and directory',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/contacts'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
  },
  {
    id: 'google-tasks',
    name: 'Google Tasks',
    category: 'Productivity',
    icon: 'CheckSquare',
    desc: 'Create and manage task lists in Google Tasks',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/tasks'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
  },
  {
    id: 'google-analytics',
    name: 'Google Analytics',
    category: 'Analytics',
    icon: 'TrendingUp',
    desc: 'Fetch web & app property traffic reports and conversions',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
    operatorHint: 'Needs a real Google OAuth client in Nango. Agent tool analytics_report requires a GA4 propertyId.',
  },
  {
    id: 'google-search-console',
    name: 'Google Search Console',
    category: 'SEO',
    icon: 'Search',
    desc: 'Analyze search performance, sitemaps & URL inspection',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/webmasters'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
    operatorHint: 'Needs a real Google OAuth client in Nango. Agent tools: search_console_sites, search_console_query.',
  },
  {
    id: 'google-business-profile',
    name: 'Google Business Profile',
    category: 'Marketing',
    icon: 'Store',
    desc: 'Manage Google business locations, posts & reviews',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/business.manage'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
    operatorHint: 'Needs a real Google OAuth client in Nango. Agent tool: business_list_locations.',
  },
  {
    id: 'google-cloud',
    name: 'Google Cloud Platform',
    category: 'Infrastructure',
    icon: 'Cloud',
    desc: 'Cloud resources, BigQuery & infrastructure management',
    authMode: 'oauth',
    extraConnectFields: [],
    extraTestFields: [],
    executorStatus: 'live',
    testable: true,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    envVars: GOOGLE_OAUTH_ENV,
    webhookEvents: [],
    operatorHint: 'Needs a real Google OAuth client in Nango with cloud-platform scope. Agent tool: cloud_list_projects.',
  },
];

export const INTEGRATION_BY_ID: Record<string, IntegrationCatalogItem> = Object.fromEntries(
  INTEGRATION_CATALOG.map((item) => [item.id, item])
);

export function getIntegration(id: string): IntegrationCatalogItem | undefined {
  return INTEGRATION_BY_ID[id];
}

export const PUBLIC_META_KEYS = ['shopDomain', 'subdomain', 'adAccountId', 'customerId', 'phoneNumberId', 'wabaId'] as const;

export type PublicMetaKey = (typeof PUBLIC_META_KEYS)[number];

export function isPublicMetaKey(key: string): key is PublicMetaKey {
  return (PUBLIC_META_KEYS as readonly string[]).includes(key);
}

/**
 * Rewrite a container-internal origin into one a browser can actually open.
 *
 * The same Nango server has two different addresses depending on who is asking.
 * This container reaches it at its compose service name, `http://nango-server:3003`;
 * a browser cannot resolve that name at all, because it exists only inside the
 * Docker network. So any URL we hand to the browser — the OAuth popup host, and
 * the "go and register a client id" link — has to be a published address.
 *
 * A single-label hostname (no dot, and not `localhost`) can only be a compose
 * service name, so we rewrite it to loopback and keep the port, which is where
 * compose publishes it. Set NEXT_PUBLIC_NANGO_HOST to state the public origin
 * explicitly; it is honoured ahead of this and is what production should use.
 *
 * This failure is silent without the guard: the popup opens on an unresolvable
 * host and the user gets a blank window with nothing in any log to explain it.
 */
export function browserReachableOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
      url.hostname = '127.0.0.1';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

export function nangoUiUrl(): string {
  return browserReachableOrigin(
    process.env.NEXT_PUBLIC_NANGO_HOST || process.env.NANGO_HOST || 'http://localhost:3003'
  );
}
