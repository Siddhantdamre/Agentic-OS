import type { ToolCatalogEntry, ToolExecutionParams, ToolExecutionResult } from '@darex/shared-types';
import { withOrgScopedClient } from './tools/shared.js';
import { executeProvider } from './tools/index.js';
import { isToolGranted, riskOf } from './tools/capability.js';

export type { ToolCatalogEntry, ToolExecutionParams, ToolExecutionResult };
export type { ToolRisk, ToolModule, ProviderKey } from './tools/index.js';
export { confirmForRisk, resolveToolRisk, getToolModule, TOOL_MODULES } from './tools/index.js';

// Tools that are safe to run for every org regardless of per-employee config.
// These are the agent's own atomic capabilities (web search/extract, scoped SQL,
// workspace files, sandboxed code execution, and public-key geocoding) — not
// external OAuth connectors. maps still returns honest notConnected without a key.
export const ALWAYS_ALLOWED_CORE_TOOLS = [
  'web_search', 'search', 'google_search',
  'deep_research', 'research', 'deep_think',
  'web_extract', 'fetch_url', 'read_url',
  'database_query', 'db_query', 'sql_analytics',
  'metrics', 'metrics_query',
  'file_ops', 'workspace_file', 'file_system',
  'sandbox', 'code_execution', 'execute_code',
  'maps', 'google-maps', 'maps_geocode', 'maps_reverse_geocode',
  're', 'realestate', 'rera', 'mls',
];

function normalizeToolKey(value: string): string {
  return String(value || '').toLowerCase().replace(/_/g, '-');
}

// Org-wide tool allowlist — cached briefly to avoid a DB hit on every call.
// The authoritative set for an org is:
//   1. always-allowed core tools (web_search, database_query, sandbox, ...)
//   2. union of ALL active employee tool_allowlists
//   3. every connector the org has actually connected (channels table)
// This means a tool the org OWNS (e.g. google-sheets connected via Nango) is
// executable even when no single employee names it in their allowlist, while
// connectors the org hasn't connected are still gated.
const allowlistCache = new Map<string, { keys: string[]; expiresAt: number }>();
const ALLOWLIST_TTL_MS = 60_000;

async function resolveOrgToolAllowlist(orgId: string): Promise<string[]> {
  const cached = allowlistCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const union = new Set<string>(ALWAYS_ALLOWED_CORE_TOOLS);
  try {
    await withOrgScopedClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT tool_allowlist FROM ai_employees WHERE org_id = $1 AND status = 'active'`,
        [orgId]
      );
      for (const row of res.rows) {
        const list = Array.isArray(row.tool_allowlist)
          ? row.tool_allowlist.map(String)
          : (() => {
              try { return JSON.parse(row.tool_allowlist).map(String); } catch { return []; }
            })();
        for (const t of list) union.add(String(t).toLowerCase());
      }

      const chanRes = await client.query(
        `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('connected','active')`,
        [orgId]
      );
      for (const c of chanRes.rows) {
        if (typeof c.channel_type === 'string') union.add(c.channel_type.toLowerCase());
      }
    });
  } catch (err: any) {
    console.warn(`[Tool Executor] Failed to resolve allowlist for ${orgId}:`, err.message);
  }
  const keys = Array.from(union);
  allowlistCache.set(orgId, { keys, expiresAt: Date.now() + ALLOWLIST_TTL_MS });
  return keys;
}

export function channelTypesFromRows(rows: unknown[]): string[] {
  const types: string[] = [];
  for (const row of rows || []) {
    if (typeof row === 'string' && row.trim()) types.push(row.trim());
    else if (row && typeof row === 'object' && 'channel_type' in (row as any)) {
      const t = String((row as any).channel_type || '').trim();
      if (t) types.push(t);
    }
  }
  return types;
}

export function mergeRuntimeAllowlist(employeeList: string[] | undefined, connectedChannels: string[] | undefined): string[] {
  const union = new Set<string>(ALWAYS_ALLOWED_CORE_TOOLS.map(normalizeToolKey));
  for (const t of employeeList || []) union.add(normalizeToolKey(t));
  for (const t of connectedChannels || []) union.add(normalizeToolKey(t));
  return Array.from(union).filter(Boolean);
}

// This used to also match `a.startsWith(tool + '-')`, which runs the grant
// BACKWARDS: holding `razorpay-refund-status` returned true for `razorpay`, so
// permission to check a refund's status conferred the entire payments provider,
// payouts included. Reproduced against the shipped code before the change.
//
// The corrected rule — permission flows downward only — lives in
// tools/capability.ts beside the test that pins it, and this file delegates so
// there is exactly one implementation of "may this employee use this tool".
function isToolAllowed(baseTool: string, allowlist: string[]): boolean {
  return isToolGranted(baseTool, allowlist);
}

export async function executeAutonomousToolAction(
  params: ToolExecutionParams
): Promise<ToolExecutionResult> {
  const timestamp = new Date().toISOString();
  const actionName = (params.action || 'auto_execute').toLowerCase();
  const baseTool = (params.tool || '').toLowerCase();
  console.log(`[Autonomous Tool Execution] Tool: ${params.tool}, Action: ${actionName}, Org: ${params.orgId}`);

  // Enforce the allowlist BEFORE any side-effect executes. The allowlist holds
  // base tool keys (e.g. 'gmail', 'database_query'); a tool request is allowed
  // if its base key is listed. An attacker / prompt-injected tool call that is
  // not on the list is rejected here. If the caller didn't pass one, fall back
  // to the org's active-employee allowlist (cached).
  const namedEmployee = Array.isArray(params.toolAllowlist) && params.toolAllowlist.length > 0;
  const effectiveAllowlist = namedEmployee
    ? params.toolAllowlist!
    : await resolveOrgToolAllowlist(params.orgId);

  // FAIL SAFE WHEN NOBODY IS NAMED.
  //
  // resolveOrgToolAllowlist returns the UNION of every active employee's tools
  // plus every connected channel. That is the right answer to "does this ORG
  // own the tool" and the wrong answer to "may THIS EMPLOYEE use it" — and it
  // was being used for both. So a caller that omitted an allowlist inherited
  // the most privileged employee in the workspace: the moment one employee is
  // given `razorpay`, an unattributed call could charge a card.
  //
  // The union still decides whether the org owns a tool at all, but with no
  // employee named the call may only READ. Acting requires somebody to say
  // which employee is acting.
  if (!namedEmployee) {
    const risk = riskOf(baseTool, actionName);
    if (risk !== 'read') {
      return {
        tool: params.tool,
        action: actionName,
        status: 'error',
        message:
          `"${params.tool}" is a ${risk} action and no employee was named for this call. `
          + 'Reads are allowed without an employee; anything that changes the world is not.',
        data: { allowed: false, reason: 'no_employee_named', risk },
        timestamp,
      };
    }
  }

  if (effectiveAllowlist.length > 0 && !isToolAllowed(baseTool, effectiveAllowlist)) {
    return {
      tool: params.tool,
      action: actionName,
      status: 'error',
      message: `Tool "${params.tool}" is not in this employee's allowed tool list.`,
      data: { allowed: false, allowlist: effectiveAllowlist },
      timestamp,
    };
  }

  try {
    const result = await executeProvider({
      tool: params.tool,
      action: params.action,
      actionName,
      payload: params.payload,
      orgId: params.orgId,
      timestamp,
    });
    if (result) return result;

    return {
      tool: params.tool,
      action: params.action,
      status: 'error',
      message: `Unknown tool "${params.tool}" — no executor registered for this tool.`,
      data: null,
      timestamp,
    };
  } catch (error: any) {
    return {
      tool: params.tool,
      action: params.action,
      status: 'error',
      message: error.message || 'Tool execution error',
      data: null,
      timestamp,
    };
  }
}

export const AUTONOMOUS_TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: 'whatsapp', category: 'Communication', description: 'Send WhatsApp messages via Meta Cloud API', mcpName: 'whatsapp_send', oauth: true },
  { name: 'gmail', category: 'Communication', description: 'Fetch, triage, draft, send Gmail; extract OTP and attachments', mcpName: 'gmail_fetch', oauth: true },
  { name: 'google-calendar', category: 'Productivity', description: 'List events, create events, check availability', mcpName: 'calendar_list_events', oauth: true },
  { name: 'github', category: 'Development', description: 'Fetch repos, create repos and issues', mcpName: 'github_fetch_repos', oauth: true },
  { name: 'hubspot', category: 'CRM', description: 'Create and update HubSpot contacts', mcpName: 'hubspot_create_contact', oauth: true },
  { name: 'meta-ads', category: 'Marketing', description: 'Fetch Meta Ads campaign metrics', mcpName: 'meta_ads_metrics', oauth: true },
  { name: 'google-ads', category: 'Marketing', description: 'Fetch Google Ads campaign metrics', mcpName: 'google_ads_metrics', oauth: true },
  { name: 'slack', category: 'Communication', description: 'Send Slack channel messages', mcpName: 'slack_send', oauth: true },
  { name: 'notion', category: 'Productivity', description: 'Search, create pages, append content', mcpName: 'notion_search', oauth: true },
  { name: 'stripe', category: 'Finance', description: 'Payment links and customer create/get', mcpName: 'stripe_create_payment_link', oauth: true },
  { name: 'shopify', category: 'E-Commerce', description: 'Fetch products and orders', mcpName: 'shopify_fetch_products', oauth: true },
  { name: 'zendesk', category: 'Support', description: 'Fetch, create, update tickets', mcpName: 'zendesk_fetch_tickets', oauth: true },
  { name: 'intercom', category: 'Support', description: 'Fetch, reply, create Intercom conversations', mcpName: 'intercom_fetch_conversations', oauth: true },
  { name: 'razorpay', category: 'Finance', description: 'Create Razorpay payment links (per-org channels.meta keys, env fallback)', mcpName: 'razorpay_create_payment_link', oauth: false },
  { name: 'google-drive', category: 'Productivity', description: 'Search, list, read, upload, share Drive files', mcpName: 'drive_search', oauth: true },
  { name: 'google-docs', category: 'Productivity', description: 'Create, read, append Google Docs', mcpName: 'docs_create', oauth: true },
  { name: 'google-sheets', category: 'Productivity', description: 'Create, read, append Google Sheets', mcpName: 'sheets_create', oauth: true },
  { name: 'google-slides', category: 'Productivity', description: 'Create Google Slides presentations', mcpName: 'slides_create', oauth: true },
  { name: 'google-forms', category: 'Productivity', description: 'Get Google Form details', mcpName: 'forms_get', oauth: true },
  { name: 'google-contacts', category: 'Productivity', description: 'List Google Contacts', mcpName: 'contacts_list', oauth: true },
  { name: 'google-tasks', category: 'Productivity', description: 'List Google Task lists and tasks', mcpName: 'tasks_list', oauth: true },
  { name: 'google-analytics', category: 'Marketing', description: 'Run a GA4 Data API report', mcpName: 'analytics_report', oauth: true },
  { name: 'google-chat', category: 'Communication', description: 'List Chat spaces and send messages', mcpName: 'chat_list_spaces', oauth: true },
  { name: 'google-meet', category: 'Productivity', description: 'Create or get Google Meet spaces', mcpName: 'meet_create_space', oauth: true },
  { name: 'google-search-console', category: 'Marketing', description: 'List sites and query Search Console analytics', mcpName: 'search_console_sites', oauth: true },
  { name: 'google-business-profile', category: 'Marketing', description: 'List Business Profile accounts and locations', mcpName: 'business_list_locations', oauth: true },
  { name: 'google-cloud', category: 'Development', description: 'List GCP projects via Resource Manager', mcpName: 'cloud_list_projects', oauth: true },
  { name: 'web_search', category: 'Core', description: 'Live web search — keyless fallback chain, no credential required', mcpName: 'web_search', oauth: false },
  { name: 'deep_research', category: 'Core', description: 'Multi-round research: search, read pages, synthesise with independent-publisher counts', mcpName: 'deep_research', oauth: false },
  { name: 'web_extract', category: 'Core', description: 'Extract page text via Jina', mcpName: 'web_extract', oauth: false },
  { name: 'database_query', category: 'Core', description: 'Read-only org-scoped SQL (SELECT/WITH, max 25 rows). Prefer metrics.query for KPIs.', mcpName: 'database_query', oauth: false },
  { name: 'metrics', category: 'Core', description: 'Semantic metrics registry (Unworked inquiries, open conversations). Not free SQL.', mcpName: 'metrics_query', oauth: false },
  { name: 'file_ops', category: 'Core', description: 'Read/write org workspace files', mcpName: 'file_ops', oauth: false },
  { name: 'code_execution', category: 'Core', description: 'Run python/node/bash in the isolated sandbox', mcpName: 'code_execution', oauth: false },
  { name: 're', category: 'Real estate', description: 'Listing search/get, inquiries, showings. Returns only stored sheet/projection rows — never invents inventory.', mcpName: 're_listings_search', oauth: false },
  { name: 'rera', category: 'Real estate', description: 'Official RERA cache lookup with URL + retrieved_at. Never invents a registration number.', mcpName: 'rera_lookup', oauth: false },
  { name: 'mls', category: 'Real estate', description: 'Licensed MLS only. Unconfigured orgs get notConnected — never scraped inventory.', mcpName: 'mls_listings_search', oauth: true },
];
