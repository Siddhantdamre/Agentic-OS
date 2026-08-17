import type { ToolExecutionResult } from '@darex/shared-types';
import type { ToolRisk } from './risk.js';
import { confirmForRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { sandbox } from './sandbox.js';
import { webSearch } from './web-search.js';
import { webExtract } from './web-extract.js';
import { databaseQuery } from './database.js';
import { fileOps } from './file-ops.js';
import { gmail } from './gmail.js';
import { googleCalendar } from './google-calendar.js';
import { github } from './github.js';
import { whatsapp } from './whatsapp.js';
import { hubspot } from './hubspot.js';
import { metaAds } from './meta-ads.js';
import { googleAds } from './google-ads.js';
import { slack } from './slack.js';
import { notion } from './notion.js';
import { stripe } from './stripe.js';
import { shopify } from './shopify.js';
import { zendesk } from './zendesk.js';
import { intercom } from './intercom.js';
import { razorpay } from './razorpay.js';
import { googleDrive } from './google-drive.js';
import { googleDocs } from './google-docs.js';
import { googleSheets } from './google-sheets.js';
import { googleSlides } from './google-slides.js';
import { googleForms } from './google-forms.js';
import { googleChat } from './google-chat.js';
import { googleMeet } from './google-meet.js';
import { googleContacts } from './google-contacts.js';
import { googleTasks } from './google-tasks.js';
import { googleAnalytics } from './google-analytics.js';
import { googleSearchConsole } from './google-search-console.js';
import { googleBusinessProfile } from './google-business-profile.js';
import { googleCloud } from './google-cloud.js';
import { microsoftOutlook } from './microsoft-outlook.js';
import { microsoftCalendar } from './microsoft-calendar.js';
import { salesforce } from './salesforce.js';
import { docusign } from './docusign.js';
import { maps } from './maps.js';
import { twilio } from './twilio.js';
import { zoho } from './zoho.js';
import { leegality } from './leegality.js';
import { quickbooks } from './quickbooks.js';
import { metrics } from './metrics.js';
import { mls, realestate } from './realestate/index.js';
import { rera } from './public/rera.js';

export type { ToolRisk } from './risk.js';
export { confirmForRisk, isToolRisk } from './risk.js';
export type { ToolModule, ToolActionContext } from './shared.js';

/**
 * Registry of provider modules. WS-14 adds new files here and a matching
 * ProviderKey case — do not grow tool-executor.ts.
 */
export const TOOL_MODULES = {
  sandbox,
  webSearch,
  webExtract,
  databaseQuery,
  fileOps,
  gmail,
  googleCalendar,
  github,
  whatsapp,
  hubspot,
  metaAds,
  googleAds,
  slack,
  notion,
  stripe,
  shopify,
  zendesk,
  intercom,
  razorpay,
  googleDrive,
  googleDocs,
  googleSheets,
  googleSlides,
  googleForms,
  googleChat,
  googleMeet,
  googleContacts,
  googleTasks,
  googleAnalytics,
  googleSearchConsole,
  googleBusinessProfile,
  googleCloud,
  microsoftOutlook,
  microsoftCalendar,
  salesforce,
  docusign,
  maps,
  twilio,
  zoho,
  leegality,
  quickbooks,
  metrics,
  realestate,
  rera,
  mls,
} as const;

/** Every switch key the old gateway accepted, including aliases. */
export const PROVIDER_KEYS = [
  'sandbox', 'code_execution', 'execute_code',
  'web_search', 'search', 'google_search',
  'web_extract', 'fetch_url', 'read_url',
  'database_query', 'db_query', 'sql_analytics',
  'file_ops', 'file_system', 'workspace_file',
  'gmail',
  'google-calendar',
  'github',
  'whatsapp',
  'hubspot',
  'meta-ads',
  'google-ads',
  'slack',
  'notion',
  'stripe',
  'shopify',
  'zendesk',
  'intercom',
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
  'microsoft-outlook',
  'microsoft-calendar',
  'salesforce',
  'docusign',
  'maps',
  'google-maps',
  'twilio',
  'zoho',
  'zoho-crm',
  'leegality',
  'quickbooks',
  'quick-books',
  'metrics',
  'metrics_query',
  're',
  'realestate',
  'rera',
  'mls',
] as const;

export type ProviderKey = typeof PROVIDER_KEYS[number];

export function isProviderKey(value: string): value is ProviderKey {
  return (PROVIDER_KEYS as readonly string[]).includes(value);
}

export function moduleForProvider(key: ProviderKey): ToolModule {
  switch (key) {
    case 'sandbox':
    case 'code_execution':
    case 'execute_code':
      return sandbox;
    case 'web_search':
    case 'search':
    case 'google_search':
      return webSearch;
    case 'web_extract':
    case 'fetch_url':
    case 'read_url':
      return webExtract;
    case 'database_query':
    case 'db_query':
    case 'sql_analytics':
      return databaseQuery;
    case 'file_ops':
    case 'file_system':
    case 'workspace_file':
      return fileOps;
    case 'gmail':
      return gmail;
    case 'google-calendar':
      return googleCalendar;
    case 'github':
      return github;
    case 'whatsapp':
      return whatsapp;
    case 'hubspot':
      return hubspot;
    case 'meta-ads':
      return metaAds;
    case 'google-ads':
      return googleAds;
    case 'slack':
      return slack;
    case 'notion':
      return notion;
    case 'stripe':
      return stripe;
    case 'shopify':
      return shopify;
    case 'zendesk':
      return zendesk;
    case 'intercom':
      return intercom;
    case 'razorpay':
      return razorpay;
    case 'google-drive':
      return googleDrive;
    case 'google-docs':
      return googleDocs;
    case 'google-sheets':
      return googleSheets;
    case 'google-slides':
      return googleSlides;
    case 'google-forms':
      return googleForms;
    case 'google-chat':
      return googleChat;
    case 'google-meet':
      return googleMeet;
    case 'google-contacts':
      return googleContacts;
    case 'google-tasks':
      return googleTasks;
    case 'google-analytics':
      return googleAnalytics;
    case 'google-search-console':
      return googleSearchConsole;
    case 'google-business-profile':
      return googleBusinessProfile;
    case 'google-cloud':
      return googleCloud;
    case 'microsoft-outlook':
      return microsoftOutlook;
    case 'microsoft-calendar':
      return microsoftCalendar;
    case 'salesforce':
      return salesforce;
    case 'docusign':
      return docusign;
    case 'maps':
    case 'google-maps':
      return maps;
    case 'twilio':
      return twilio;
    case 'zoho':
    case 'zoho-crm':
      return zoho;
    case 'leegality':
      return leegality;
    case 'quickbooks':
    case 'quick-books':
      return quickbooks;
    case 'metrics':
    case 'metrics_query':
      return metrics;
    case 're':
    case 'realestate':
      return realestate;
    case 'rera':
      return rera;
    case 'mls':
      return mls;
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

export function getToolModule(tool: string): ToolModule | undefined {
  const key = tool.toLowerCase();
  if (!isProviderKey(key)) return undefined;
  return moduleForProvider(key);
}

export function resolveToolRisk(tool: string, action: string): { risk: ToolRisk; confirm: boolean } | null {
  const mod = getToolModule(tool);
  if (!mod) return null;
  const risk = mod.risk(action);
  return { risk, confirm: confirmForRisk(risk) };
}

export async function executeProvider(
  ctx: ToolActionContext,
): Promise<ToolExecutionResult | null> {
  const mod = getToolModule(ctx.tool);
  if (!mod) return null;
  return mod.execute(ctx);
}
