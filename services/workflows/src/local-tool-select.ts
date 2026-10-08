/**
 * Pure tool-selection helpers for the in-process TrueForge DarexLocalToolSet.
 * Separated so unit tests can cover allowlist intersection without loading trueforge-core.
 */

import { ALWAYS_ALLOWED_CORE_TOOLS } from './tool-executor.js';
import { filterCatalogByAllowlist } from './skills/catalog.js';
import type { ToolDef } from './tool-definitions.js';

/** Full MCP catalog is ~109 tools. Stay above that so an allowlisted org
 *  keeps every tool in the chat schema. Truncation is only a backstop. */
const MAX_SCHEMA_TOOLS = 160;

function normalizeKey(value: string): string {
  return String(value || '').toLowerCase().replace(/_/g, '-');
}

/**
 * Intent/role hints used only to prioritize which *already-allowed* tools
 * appear in the schema when the allowlist is large. Never grants new tools.
 */
function intentPriorityKeys(employeeRole?: string, userMessage?: string): Set<string> {
  const selected = new Set<string>();
  const roleStr = String(employeeRole || '').toLowerCase();
  const msgStr = String(userMessage || '').toLowerCase();

  if (/growth|sales|sdr|marketing|outreach|business/i.test(roleStr)) {
    ['hubspot', 'apollo', 'linkedin', 'gmail', 'google-calendar'].forEach((t) => selected.add(t));
  } else if (/customer|support|success|service/i.test(roleStr)) {
    ['zendesk', 'intercom', 'shopify', 'slack', 'gmail'].forEach((t) => selected.add(t));
  } else if (/operation|ops|finance|executive|admin|manager/i.test(roleStr)) {
    ['google-sheets', 'google-docs', 'google-slides', 'slack', 'stripe', 'google-calendar'].forEach((t) =>
      selected.add(t)
    );
  }

  const hints: Array<[RegExp, string]> = [
    [/email|gmail|inbox|mail/i, 'gmail'],
    [/calendar|meeting|event|schedule/i, 'google-calendar'],
    [/slide|presentation|pitch deck|deck/i, 'google-slides'],
    [/google doc|document|brief|memo/i, 'google-docs'],
    [/sheet|spreadsheet|csv|table/i, 'google-sheets'],
    [/drive|folder/i, 'google-drive'],
    [/slack|channel/i, 'slack'],
    [/hubspot|crm|contact|deal|pipeline/i, 'hubspot'],
    [/stripe|charge|payment|refund|invoice|mrr|arr/i, 'stripe'],
    [/razorpay/i, 'razorpay'],
    [/quickbooks|quick books/i, 'quickbooks'],
    [/apollo|enrich|lead/i, 'apollo'],
    [/linkedin/i, 'linkedin'],
    [/shopify|product|order/i, 'shopify'],
    [/zendesk|ticket/i, 'zendesk'],
    [/intercom/i, 'intercom'],
    [/whatsapp/i, 'whatsapp'],
    [/instagram|\bdms?\b/i, 'instagram'],
    [/notion/i, 'notion'],
    [/github|repo|pull request/i, 'github'],
    [/salesforce/i, 'salesforce'],
    [/outlook/i, 'microsoft-outlook'],
    [/docusign|envelope/i, 'docusign'],
    [/twilio|sms/i, 'twilio'],
    [/zoho/i, 'zoho'],
    [/leegality/i, 'leegality'],
    [/meta ads|facebook ads/i, 'meta-ads'],
    [/google ads/i, 'google-ads'],
  ];
  for (const [pattern, key] of hints) {
    if (pattern.test(msgStr)) selected.add(key);
  }

  return selected;
}

/**
 * Select tools for an in-process turn.
 * - Always intersects with the allowlist (or core-only when empty).
 * - Returns every allowed tool until the schema cap; past the cap, the
 *   message's tools and core tools stay ahead of catalog order.
 * - Never invents connectors the tenant does not own.
 */
export function selectToolsForLocalTurn(
  catalog: ToolDef[],
  toolAllowlist: string[] | undefined,
  employeeRole?: string,
  userMessage?: string
): ToolDef[] {
  const allowed = filterCatalogByAllowlist(catalog, toolAllowlist, ALWAYS_ALLOWED_CORE_TOOLS);
  if (allowed.length <= MAX_SCHEMA_TOOLS) {
    return allowed;
  }

  // Backstop only: keep the tools this message asked for, then core tools,
  // then the rest of the allowlist. Catalog order must not drop the tail
  // (QuickBooks, Cognee, Outlook, …) when the org owns many connectors.
  const priority = intentPriorityKeys(employeeRole, userMessage);
  const core = new Set(ALWAYS_ALLOWED_CORE_TOOLS.map(normalizeKey));
  const rank = (t: ToolDef): number => {
    const n = normalizeKey(t.name);
    const p = normalizeKey(t.tool);
    if (priority.has(n) || priority.has(p)) return 0;
    if (core.has(n) || core.has(p)) return 1;
    return 2;
  };
  return [...allowed].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_SCHEMA_TOOLS);
}

/**
 * Map a model tool call onto the executor action.
 * file_ops stores the real action (read_file / write_file) on the arguments,
 * while the catalog action is auto_execute. The MCP bridge already honors
 * the argument; the in-process chat path must do the same or every write
 * is executed as a read.
 */
export function resolveLocalToolInvocation(
  def: { tool: string; action: string },
  raw: Record<string, unknown>,
): { action: string; payload: Record<string, unknown> } {
  const payload = { ...raw };
  delete payload.org_id;
  if (normalizeKey(def.tool) === 'file-ops') {
    const requested = typeof payload.action === 'string' ? payload.action.trim() : '';
    delete payload.action;
    return { action: requested || 'read_file', payload };
  }
  return { action: def.action, payload };
}
