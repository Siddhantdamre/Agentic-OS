import type { ToolCatalogEntry, ToolExecutionParams, ToolExecutionResult } from '@darex/shared-types';
import { TOOL_EXECUTION_TIMEOUT_MS, withOrgScopedClient } from './tools/shared.js';
import { executeProvider, resolveToolRisk, type ToolRisk } from './tools/index.js';
import { filterAllowlistForPersona, normalizeEmployeePersona, roleCapabilityDenial } from './tools/role-capability.js';
import { withProviderRateLimit } from './tools/provider-rate-limit.js';
import { checkContactDuplicateActivity } from './activities/dedup.js';
import { backfillContactFieldsActivity } from './activities/enrichment.js';
import {
  autonomyRun,
  buildActionSummary,
  checkAutonomy,
  logAutonomyDecision,
  parkPendingAction,
} from './autonomy.js';
import { logDecision } from './operations/decision-ledger.js';
import { recordEmployeeMetrics } from './employee-metrics.js';
import { criticCheck } from './activities/critic-check.js';
import { defaultQuietHours, isQuietHour } from './quiet-hours.js';
import { gateEntitlement, gateOrgRunnable, gatePayRbac } from './tools/gate-hooks.js';
import {
  CORE_READ_TOOLS,
  runToolGate,
  type GateDeps,
  type GateEmployee,
  type GateParams,
  type GateResult,
} from './tool-gate.js';

export type { ToolCatalogEntry, ToolExecutionParams, ToolExecutionResult };
export type { ToolRisk, ToolModule, ProviderKey } from './tools/index.js';
export { confirmForRisk, resolveToolRisk, getToolModule, TOOL_MODULES } from './tools/index.js';
export { CORE_READ_TOOLS, NEVER_CORE_TOOLS, resolveTurnAllowlist } from './tool-gate.js';
export type { GateParams, GateResult, GateDenyReason } from './tool-gate.js';
import { TOOLS } from './tool-definitions.js';
import { minAutonomyForTool } from './skills/catalog.js';
import { assertUsageAllowed } from './usage-gate.js';
import { auditToolInvocation } from './tool-audit.js';

export { TOOL_EXECUTION_TIMEOUT_MS };

export const ALWAYS_ALLOWED_CORE_TOOLS = CORE_READ_TOOLS;

function normalizeToolKey(value: string): string {
  return String(value || '').toLowerCase().replace(/_/g, '-');
}

async function loadEmployeeAutonomyTier(orgId: string, employeeRole?: string): Promise<number> {
  if (!employeeRole) return 2;
  try {
    let tier = 2;
    await withOrgScopedClient(orgId, async (client) => {
      const res = await client.query<{ autonomy_tier: number }>(
        `SELECT autonomy_tier FROM employee_autonomy_rules
          WHERE org_id = $1 AND (employee_role IS NULL OR employee_role = $2)
          ORDER BY employee_role NULLS LAST
          LIMIT 1`,
        [orgId, employeeRole]
      );
      if (res.rows[0]?.autonomy_tier != null) {
        tier = Number(res.rows[0].autonomy_tier);
      }
    });
    return tier;
  } catch {
    return 2;
  }
}

/**
 * Run `run` with a deadline. On timeout the signal handed to `run` is
 * aborted, so provider requests stop instead of committing after the model
 * was told the call failed (RT-B04).
 */
export async function executeWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${label} exceeded execution timeout of ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

export function mergeRuntimeAllowlist(employeeList: string[] | undefined, connectedChannels: string[] | undefined, employeeRole?: string): string[] {
  const union = new Set<string>(ALWAYS_ALLOWED_CORE_TOOLS.map(normalizeToolKey));
  for (const t of employeeList || []) union.add(normalizeToolKey(t));
  for (const t of connectedChannels || []) union.add(normalizeToolKey(t));
  return filterAllowlistForPersona(Array.from(union).filter(Boolean), employeeRole);
}

// Bidirectional mappings between MCP tool names and base provider keys
const TOOL_TO_PROVIDER = new Map<string, string>();
const PROVIDER_TO_TOOLS = new Map<string, Set<string>>();

for (const def of TOOLS) {
  const normName = normalizeToolKey(def.name);
  const normProvider = normalizeToolKey(def.tool);
  TOOL_TO_PROVIDER.set(normName, normProvider);
  let set = PROVIDER_TO_TOOLS.get(normProvider);
  if (!set) {
    set = new Set();
    PROVIDER_TO_TOOLS.set(normProvider, set);
  }
  set.add(normName);
}

/**
 * Risk for a call named either by provider key (`stripe`) or by MCP tool name
 * (`stripe_create_charge`). A name with no module and no definition is null,
 * and the gate refuses it rather than guessing a risk.
 */
export function resolveCallRisk(tool: string, action: string): { risk: ToolRisk; confirm: boolean } | null {
  const direct = resolveToolRisk(tool, action);
  if (direct) return direct;
  const def = TOOLS.find((d) => normalizeToolKey(d.name) === normalizeToolKey(tool));
  if (!def) return null;
  return resolveToolRisk(def.tool, action && action !== 'auto_execute' ? action : def.action)
    ?? resolveToolRisk(def.tool, def.action);
}

export function isToolAllowed(baseTool: string, allowlist: string[]): boolean {
  const tool = normalizeToolKey(baseTool);
  const allowed = allowlist.map(normalizeToolKey).filter(Boolean);
  if (allowed.includes(tool)) return true;

  // Check if baseTool is a known MCP tool name whose provider is in allowed
  const providerForTool = TOOL_TO_PROVIDER.get(tool);
  if (providerForTool && allowed.includes(providerForTool)) return true;

  // Check if baseTool is a provider key and any of its MCP tool names are in allowed
  const toolsForProvider = PROVIDER_TO_TOOLS.get(tool);
  if (toolsForProvider) {
    for (const a of allowed) {
      if (toolsForProvider.has(a)) return true;
    }
  }

  // Exact provider ↔ catalog-name match only. A prefix (`stripe`) must not
  // allow a different tool id (`stripe_create_charge`).
  for (const a of allowed) {
    const providerForA = TOOL_TO_PROVIDER.get(a);
    if (providerForA && (providerForA === tool || providerForA === providerForTool)) return true;
    const toolsForA = PROVIDER_TO_TOOLS.get(a);
    if (toolsForA && (toolsForA.has(tool) || (providerForTool && toolsForA.has(providerForTool)))) return true;
  }

  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePersona(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // plain-text persona has no rosterKey
    }
  }
  return {};
}

export function toGateEmployee(row: Record<string, any>): GateEmployee {
  const persona = parsePersona(row.persona);
  const list = Array.isArray(row.tool_allowlist) ? row.tool_allowlist : [];
  return {
    id: String(row.id),
    name: String(row.name || row.role || 'employee'),
    role: String(row.role || ''),
    rosterKey: typeof persona.rosterKey === 'string' && persona.rosterKey.trim() ? persona.rosterKey.trim().toLowerCase() : null,
    toolAllowlist: list.map((t: unknown) => String(t).trim()).filter(Boolean),
    status: String(row.status || 'active').toLowerCase(),
  };
}

/**
 * Internal callers (sweeps, guarded sends) name a role, not an id. Match the
 * org's employee by exact role, then rosterKey, then persona family. Active
 * rows win over paused ones. No match → null → `missing_employee`.
 */
export function pickEmployeeForRole(rows: GateEmployee[], role: string | undefined): GateEmployee | null {
  const wanted = String(role || '').trim().toLowerCase();
  if (!wanted) return null;
  const persona = normalizeEmployeePersona(wanted);
  const tiers: Array<(e: GateEmployee) => boolean> = [
    (e) => e.role.toLowerCase() === wanted,
    (e) => e.rosterKey === wanted,
    (e) => persona !== null && normalizeEmployeePersona(e.rosterKey || e.role) === persona,
  ];
  for (const match of tiers) {
    const hits = rows.filter(match);
    const active = hits.find((e) => e.status === 'active');
    if (active || hits[0]) return active || hits[0];
  }
  return null;
}

async function loadGateEmployee(orgId: string, ref: { employeeId?: string; employeeRole?: string }): Promise<GateEmployee | null> {
  if (ref.employeeId && !UUID_RE.test(ref.employeeId)) return null;
  if (!ref.employeeId && !ref.employeeRole) return null;
  try {
    return await withOrgScopedClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT id, name, role, persona, tool_allowlist, status
           FROM ai_employees
          WHERE org_id = $1 AND archived_at IS NULL ${ref.employeeId ? 'AND id = $2' : ''}
          ORDER BY created_at ASC`,
        ref.employeeId ? [orgId, ref.employeeId] : [orgId],
      );
      const rows = res.rows.map(toGateEmployee);
      if (ref.employeeId) return rows[0] ?? null;
      return pickEmployeeForRole(rows, ref.employeeRole);
    });
  } catch (err) {
    console.error(`[Tool Executor] employee lookup failed for ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function loadApprovedAction(orgId: string, pendingActionId: string) {
  if (!UUID_RE.test(pendingActionId)) return null;
  return withOrgScopedClient(orgId, async (client) => {
    const res = await client.query<{ id: string; payload: any; modified_payload: any }>(
      `SELECT id, payload, modified_payload FROM agent_pending_actions
        WHERE id = $1 AND org_id = $2 AND status = 'approved'`,
      [pendingActionId, orgId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const stored = (row.payload || {}) as Record<string, any>;
    const base = stored.payload && typeof stored.payload === 'object' && !Array.isArray(stored.payload) ? stored.payload : {};
    const modified = row.modified_payload && typeof row.modified_payload === 'object' ? row.modified_payload : null;
    return {
      id: String(row.id),
      tool: String(stored.tool || ''),
      action: String(stored.action || 'auto_execute').toLowerCase(),
      args: (modified || base) as Record<string, unknown>,
    };
  });
}

async function writeLedgerRow(entry: Parameters<GateDeps['logLedger']>[0]): Promise<void> {
  try {
    recordEmployeeMetrics({
      orgId: entry.orgId,
      employeeRole: entry.employeeRole || 'unknown',
      actionType: `${entry.tool}.${entry.action}`,
      decision: entry.decision,
      reasonCode: entry.reasonCode,
    });
    await withOrgScopedClient(entry.orgId, async (client) => {
      await logDecision(client, {
        orgId: entry.orgId,
        employeeRole: entry.employeeRole || 'unknown',
        employeeId: entry.employeeId,
        actionConsidered: `${entry.tool}.${entry.action}`,
        decision: entry.decision,
        reasonCode: entry.reasonCode,
        reasonSummary: `${entry.decision} via ${entry.reasonCode}`,
        confidence: 0,
        contextPayload: { tool: entry.tool, action: entry.action, employeeId: entry.employeeId, payload: entry.payload },
      });
    });
  } catch (err) {
    console.warn(`[Tool Executor] ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function orgInQuietHours(orgId: string): Promise<boolean> {
  try {
    const timeZone = await withOrgScopedClient(orgId, async (client) => {
      const res = await client.query<{ timezone: string | null }>(
        `SELECT COALESCE(
                  (SELECT NULLIF(timezone, '') FROM org_onboarding WHERE org_id = $1),
                  (SELECT NULLIF(meta->>'timezone', '') FROM orgs WHERE id = $1)
                ) AS timezone`,
        [orgId],
      );
      return String(res.rows[0]?.timezone || 'UTC');
    });
    const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date()));
    return isQuietHour(hour, defaultQuietHours(timeZone));
  } catch {
    // Unknown timezone or DB error: treat as quiet so an unattended send waits.
    return true;
  }
}

async function invokeProvider(
  params: GateParams,
  ctx: { actionName: string; employee: GateEmployee; timestamp: string },
): Promise<ToolExecutionResult> {
  const { actionName, timestamp } = ctx;
  const baseTool = (params.tool || '').toLowerCase();
  try {
    const result = await executeWithTimeout(
      (signal) => withProviderRateLimit(params.orgId, baseTool, async () => {
        return executeProvider({
          tool: params.tool,
          action: params.action,
          actionName,
          payload: params.payload,
          orgId: params.orgId,
          timestamp,
          signal,
        });
      }),
      TOOL_EXECUTION_TIMEOUT_MS,
      `Tool ${params.tool}`
    );
    if (result) {
      // OE-06: trigger the fuzzy dedup check whenever a contact is created,
      // regardless of which employee created it. Best-effort — a dedup
      // failure never undoes or blocks the contact that was just created.
      if (baseTool === 'hubspot' && actionName.includes('create') && result.status === 'executed') {
        const email = (params.payload as Record<string, unknown> | undefined)?.email;
        const name =
          [
            (params.payload as Record<string, unknown> | undefined)?.firstname,
            (params.payload as Record<string, unknown> | undefined)?.lastname,
          ]
            .filter(Boolean)
            .join(' ')
            .trim() || String(email || 'unknown contact');
        checkContactDuplicateActivity({
          orgId: params.orgId,
          name,
          email: typeof email === 'string' ? email : null,
          domain: typeof email === 'string' ? email.split('@')[1] || null : null,
          phone: typeof (params.payload as Record<string, unknown> | undefined)?.phone === 'string'
            ? String((params.payload as Record<string, unknown>).phone)
            : null,
        }).catch((err) => {
          console.warn(`[Tool Executor] dedup check failed for org ${params.orgId}: ${err instanceof Error ? err.message : String(err)}`);
        });

        // OE-07: a freshly created contact is, by definition, missing
        // whatever fields the caller did not supply — check whether phone
        // or title can be backfilled from an existing inbound email thread.
        if (typeof email === 'string') {
          backfillContactFieldsActivity({
            orgId: params.orgId,
            contactEmail: email,
            actor: {
              toolAllowlist: params.toolAllowlist,
              employeeRole: params.employeeRole,
              employeeId: params.employeeId,
              actorUserId: params.actorUserId,
              workflowId: params.workflowId,
            },
            execute: executeAutonomousToolAction,
          }).catch((err) => {
            console.warn(`[Tool Executor] contact enrichment failed for org ${params.orgId}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
      return result;
    }

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

export const defaultGateDeps: GateDeps = {
  runContext: () => autonomyRun.getStore(),
  orgRunState: gateOrgRunnable,
  loadEmployee: loadGateEmployee,
  usageBlock: async (orgId) => {
    const block = await assertUsageAllowed(orgId);
    return block ? { message: block.message, reasons: block.gate.reasons } : null;
  },
  entitlement: gateEntitlement,
  payRbac: gatePayRbac,
  loadApprovedAction,
  riskFor: resolveCallRisk,
  isAllowed: isToolAllowed,
  personaDenial: (role, tool, action, card) => roleCapabilityDenial(role, tool, action, card),
  skillTierBlock: async (orgId, employeeRole, tool, action) => {
    const baseTool = tool.toLowerCase();
    const required = Math.max(minAutonomyForTool(baseTool), minAutonomyForTool(tool), minAutonomyForTool(action));
    if (required <= 1) return null;
    const tier = await loadEmployeeAutonomyTier(orgId, employeeRole);
    return tier < required
      ? `Action blocked: autonomy tier ${tier} is below skill minimum ${required} for "${tool}".`
      : null;
  },
  checkAutonomy,
  logAutonomy: (input) => logAutonomyDecision(input),
  logLedger: writeLedgerRow,
  park: async (input) => {
    const pending = await parkPendingAction({
      orgId: input.orgId,
      workflowId: input.workflowId,
      actionType: input.actionType,
      employeeRole: input.employeeRole,
      payload: input.payload,
      tool: input.tool,
      action: input.action,
      reasonCode: input.reasonCode,
    });
    return { pendingActionId: pending.pendingActionId || null, workItemId: pending.workItemId || null };
  },
  summarize: buildActionSummary,
  critic: async (orgId, draft) => {
    if (!draft.trim()) return { allow: true, reason: 'no draft text' };
    const verdict = await criticCheck({ orgId, draft, intent: 'send' });
    return { allow: verdict.allow, reason: verdict.reason };
  },
  inQuietHours: orgInQuietHours,
  invoke: invokeProvider,
};

/**
 * The only production entry to a side effect. Order and deny reasons live in
 * `tool-gate.ts` (17 §2); this wires the real DB, hooks, and provider.
 */
export async function executeAutonomousToolAction(params: GateParams): Promise<GateResult> {
  console.log(`[Autonomous Tool Execution] Tool: ${params.tool}, Action: ${params.action}, Org: ${params.orgId}, Source: ${params.source || 'unspecified'}`);
  // Every call writes one append-only tool_invocations row (RT-G06); the
  // write is fire-and-forget and never changes or blocks the result.
  const started = Date.now();
  const runCtx = autonomyRun.getStore();
  const audit = {
    params,
    employeeRole: params.employeeRole || runCtx?.employeeRole,
    workflowId: params.workflowId || runCtx?.workflowId,
  };
  try {
    const result = await runToolGate(params, defaultGateDeps);
    auditToolInvocation({ ...audit, result, latencyMs: Date.now() - started });
    return result;
  } catch (thrown) {
    auditToolInvocation({ ...audit, thrown, latencyMs: Date.now() - started });
    throw thrown;
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
  { name: 'slack', category: 'Communication', description: 'Send Slack messages and post Block Kit decision cards', mcpName: 'slack_send', oauth: true },
  { name: 'notion', category: 'Productivity', description: 'Search, create pages, append content', mcpName: 'notion_search', oauth: true },
  { name: 'stripe', category: 'Finance', description: 'Payment links, approval-gated charges, and customer create/get', mcpName: 'stripe_create_payment_link', oauth: true },
  { name: 'connectors', category: 'Platform', description: 'Read-only connector status and live ping for the org', mcpName: 'connectors_status', oauth: false },
  { name: 'billing', category: 'Finance', description: 'Read org Darex billing meters and subscription (RLS)', mcpName: 'billing_usage', oauth: false },
  { name: 'quickbooks', category: 'Finance', description: 'List QuickBooks customers and invoices', mcpName: 'quickbooks_list_invoices', oauth: true },
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
  { name: 'web_search', category: 'Core', description: 'Live web search via Jina', mcpName: 'web_search', oauth: false },
  { name: 'web_extract', category: 'Core', description: 'Extract page text via Jina', mcpName: 'web_extract', oauth: false },
  { name: 'database_query', category: 'Core', description: 'Read-only org-scoped SQL (SELECT/WITH, max 25 rows). Prefer metrics.query for KPIs.', mcpName: 'database_query', oauth: false },
  { name: 'metrics', category: 'Core', description: 'Semantic metrics registry (Unworked inquiries, open conversations). Not free SQL.', mcpName: 'metrics_query', oauth: false },
  { name: 'file_ops', category: 'Core', description: 'Read/write org workspace files', mcpName: 'file_ops', oauth: false },
  { name: 'code_execution', category: 'Core', description: 'Run python/node/bash in the isolated sandbox', mcpName: 'code_execution', oauth: false },
  { name: 're', category: 'Real estate', description: 'Listing search/get, inquiries, showings. Returns only stored sheet/projection rows — never invents inventory.', mcpName: 're_listings_search', oauth: false },
  { name: 'rera', category: 'Real estate', description: 'Official RERA cache lookup with URL + retrieved_at. Never invents a registration number.', mcpName: 'rera_lookup', oauth: false },
  { name: 'mls', category: 'Real estate', description: 'Licensed MLS only. Unconfigured orgs get notConnected — never scraped inventory.', mcpName: 'mls_listings_search', oauth: true },
  { name: 'linkedin', category: 'Prospecting', description: 'People search and company signals. Honest notConnected when unconfigured.', mcpName: 'linkedin_search_people', oauth: true },
  { name: 'apollo', category: 'Prospecting', description: 'People search and company enrichment. Honest notConnected when unconfigured.', mcpName: 'apollo_search_people', oauth: true },
  { name: 'operations', category: 'Operations', description: 'Reconcile, dedup, calendar deadlocks, meeting prep, work items, expected-vs-actual, rent reminder drafts', mcpName: 'ops_reconcile_audit', oauth: false },
];

/**
 * OAuth vs core split — the single source of truth for "does this tool need
 * Nango?". OAuth tools resolve `{org}_{provider}` tokens via Nango (TrueForge
 * never holds credentials); core tools (search, SQL, sandbox, files, metrics,
 * cognee, re/rera, maps, razorpay-BYOK) must never touch Nango.
 */
const OAUTH_TOOL_KEYS = new Set(
  AUTONOMOUS_TOOL_CATALOG.filter((e) => e.oauth).map((e) => normalizeToolKey(e.name)),
);

export function isOAuthTool(tool: string): boolean {
  return OAUTH_TOOL_KEYS.has(normalizeToolKey(tool));
}
