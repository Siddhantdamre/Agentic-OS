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
import { readTurnGrant, takeHostSessionId } from './tools/turn-grant.js';

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

  /**
   * A SELF-DIRECTED TURN'S OWN GRANT, when the call carried one.
   *
   * `duties.ts` promises a duty runs with the minimum tool and never the
   * employee's full authority. That was computed by `planDuty`, asserted by
   * `duties.test.ts`, and then discarded here: this function is reached from
   * the MCP bridge, a separate process that receives only what the model puts
   * in a tool call, so it fell back to the org-wide union.
   *
   * Measured. Emma's duty, allowlist `["database_query"]`, reached
   * `metrics_list`, `metrics_query` and `intercom_fetch_conversations` —
   * intercom being neither in her employee allowlist nor connected in that
   * workspace, admitted because another employee holds it and the call reads.
   *
   * Patch 0003 forwards the host's session id on every MCP tool call; the
   * grant is looked up by it. Read BEFORE the org fallback so a duty is
   * constrained by its own allowlist rather than its workspace's.
   *
   * Narrowing only. No grant, an expired grant, or a call without a session id
   * leaves the behaviour exactly as it was — because treating a missing grant
   * as "deny" would turn one stale row into an outage on live conversations.
   */
  const hostSessionId = takeHostSessionId(params.payload as Record<string, unknown>);
  const turnGrant = !namedEmployee && hostSessionId
    ? await readTurnGrant(params.orgId, hostSessionId)
    : null;

  /**
   * A GRANT NAMES THE EMPLOYEE, so the turn is attributed.
   *
   * The read-only floor below exists because an unattributed write is a write
   * nobody can be held to. Nothing ever named an employee on this path, so
   * EVERY write through the MCP bridge was refused — measured:
   * google-calendar.create_event, gmail.draft_email and
   * hubspot.create_crm_contact all `no_employee_named`. The agent could answer
   * and could not act.
   *
   * It was customer-visible. Asked to book a Saturday viewing, the reply was
   * "I couldn't check availability... please provide the name of the employee
   * handling the booking" — the internal refusal, paraphrased to a customer.
   *
   * A grant IS the naming: written by the worker before the turn, keyed by a
   * session id the model never sees. Honouring it satisfies the floor's own
   * requirement rather than bypassing it. Risk class, confirm policy, the
   * critic and durable execution for sends are all untouched.
   */
  const attributed = namedEmployee || Boolean(turnGrant?.employeeId);

  const effectiveAllowlist = namedEmployee
    ? params.toolAllowlist!
    : turnGrant?.allowlist ?? await resolveOrgToolAllowlist(params.orgId);

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
  if (!attributed) {
    const risk = riskOf(baseTool, actionName);
    if (risk !== 'read') {
      return {
        tool: params.tool,
        action: actionName,
        status: 'error',
        /**
         * WRITTEN FOR THE AGENT THAT READS IT, NOT THE DEVELOPER WHO WROTE IT.
         *
         * A tool result goes into the model's context, and the model will
         * paraphrase it to a customer if it has nothing better. It did:
         * "I couldn't book the showroom viewing as no employee was named for
         * this action. Please provide the employee details to proceed."
         *
         * That is this string, reaching a customer. So the message now tells
         * the agent what to DO, and says explicitly not to repeat it. The
         * machine-readable reason stays in `data` where the model will not
         * quote it.
         */
        message:
          'This action cannot be completed on this turn. Do NOT tell the customer '
          + 'about tools, permissions or systems, and do NOT ask them for information '
          + 'about this business. Answer from the facts you already have, and if the '
          + 'action itself was the request, say you will confirm it and have a '
          + 'colleague follow up.',
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
      // Same reasoning as above: this text can reach a customer through the
      // model, so it instructs rather than diagnoses. The tool name and the
      // allowlist stay in `data` for the log and the checks.
      message:
        'You do not hold this tool for this conversation. Do NOT mention tools, '
        + 'permissions or systems to the customer, and do NOT ask them for information '
        + 'about this business. Use the tools you were told you hold, or answer from '
        + 'the retrieved facts.',
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
