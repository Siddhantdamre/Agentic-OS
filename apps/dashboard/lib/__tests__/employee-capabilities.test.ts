/**
 * @jest-environment node
 *
 * One case per capabilities-table row in docs/new-109-pg-plan/gap26sept/employees/*.md.
 * Asserts Auto routing, provision allowlist (or hand-off), and real autonomy/role-capability
 * gates for risky tools. Executor honesty lives in services/workflows when package-bound.
 */
import { resolveActionType } from '@darex/shared-types';
import { checkAutonomy } from '@darex/workflows/dist/autonomy';
import { route, type RouteEmployee } from '@darex/workflows/dist/route-employee';
import {
  ALWAYS_ALLOWED_CORE_TOOLS,
  mergeRuntimeAllowlist,
} from '@darex/workflows/dist/tool-executor';
import {
  filterAllowlistForPersona,
  roleCapabilityDenial,
} from '@darex/workflows/dist/tools/role-capability';
import { allowlistForLockedEmployeeTurn } from '../ask-employee';
import { DEFAULT_EMPLOYEE_ROSTER } from '../employee-provision';
import { resolveLockedHandoff } from '../handoffs/index';

type CapKind = 'own' | 'handoff' | 'pick' | 'custom';

interface CapRow {
  spec: string;
  capability: string;
  message: string;
  /** Expected Auto-routed employee name (own rows). */
  expectName?: string;
  /** Alternate acceptable Auto names (e.g. Customer vs Emma both support). */
  expectNames?: string[];
  /** Tools that must be covered by that role's seed allowlist ∪ core. */
  tools?: string[];
  /** Provider keys that must appear on the seed allowlist (when tools are MCP names). */
  providers?: string[];
  /** Risky tool/action pairs gated by checkAutonomy / roleCapabilityDenial. */
  risky?: Array<{ tool: string; action: string; role: string }>;
  kind?: CapKind;
  /** Locked-turn hand-off: fromRole + expected toRole. */
  handoff?: { fromRole: string; toRoleIncludes: string | RegExp; message?: string };
}

const ORG = '00000000-0000-4000-8000-00000000c4p2';

function personaPlain(raw: unknown): string {
  if (typeof raw !== 'string') return String(raw ?? '');
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { text?: string };
    return typeof parsed.text === 'string' ? parsed.text : trimmed;
  } catch {
    return trimmed;
  }
}

function fullRoster(): RouteEmployee[] {
  return DEFAULT_EMPLOYEE_ROSTER.map((row, i) => ({
    id: `emp-${i}-${row.name.toLowerCase().replace(/\s+/g, '-')}`,
    name: row.name,
    role: row.role,
    persona: personaPlain(row.persona),
    toolAllowlist: [...row.tool_allowlist],
    status: row.status === 'paused' ? 'paused' : 'active',
  }));
}

function seedFor(nameOrRole: string) {
  const hit = DEFAULT_EMPLOYEE_ROSTER.find(
    (e) => e.name === nameOrRole || e.role === nameOrRole,
  );
  if (!hit) throw new Error(`no seed employee ${nameOrRole}`);
  return hit;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/_/g, '-');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Map MCP / catalog tool names from the specs onto provision provider keys. */
const TOOL_TO_PROVIDER: Record<string, string> = {
  hubspot_create_contact: 'hubspot',
  hubspot_update_contact: 'hubspot',
  hubspot_list_deals: 'hubspot',
  hubspot_create_deal: 'hubspot',
  hubspot_update_deal: 'hubspot',
  hubspot_search_contacts: 'hubspot',
  salesforce_list_contacts: 'salesforce',
  salesforce_create_contact: 'salesforce',
  salesforce_create_lead: 'salesforce',
  salesforce_list_deals: 'salesforce',
  salesforce_create_deal: 'salesforce',
  salesforce_update_deal: 'salesforce',
  zoho_list_contacts: 'zoho-crm',
  zoho_create_contact: 'zoho-crm',
  zoho_create_lead: 'zoho-crm',
  zoho_list_deals: 'zoho-crm',
  zoho_create_deal: 'zoho-crm',
  zoho_update_deal: 'zoho-crm',
  apollo_search_people: 'apollo',
  apollo_enrich_company: 'apollo',
  linkedin_search_people: 'linkedin',
  linkedin_company_signals: 'linkedin',
  calendar_create_event: 'google-calendar',
  calendar_check_availability: 'google-calendar',
  calendar_list_events: 'google-calendar',
  calendar_update_event: 'google-calendar',
  re_inquiry_listing_match: 're',
  re_showing_book: 're',
  gmail_send: 'gmail',
  gmail_draft_email: 'gmail',
  gmail: 'gmail',
  whatsapp_send: 'whatsapp',
  stripe_create_payment_link: 'stripe',
  stripe_create_charge: 'stripe',
  stripe_create_refund: 'stripe',
  stripe_get_customer: 'stripe',
  razorpay_create_payment_link: 'razorpay',
  quickbooks_list_invoices: 'quickbooks',
  billing_usage: 'billing_usage',
  zendesk_fetch_tickets: 'zendesk',
  zendesk_create_ticket: 'zendesk',
  intercom_fetch_conversations: 'intercom',
  intercom_create_conversation: 'intercom',
  customer_list_open_loops: 'customer-ops',
  customer_list_at_risk: 'customer-ops',
  growth_list_dormant_leads: 'growth',
  growth_list_pipeline_attribution: 'growth',
  growth_pipeline_roi: 'growth',
  ops_reconcile_audit: 'operations',
  ops_dedup_contacts: 'operations',
  ops_calendar_deadlocks: 'operations',
  ops_meeting_prep: 'operations',
  ops_list_discrepancies: 'operations',
  work_item_create: 'operations',
  work_item_reassign: 'operations',
  work_item_set_priority: 'operations',
  rent_reminders_list: 'operations',
  sheets_read: 'google-sheets',
  sheets_append_row: 'google-sheets',
  database_query: 'database_query',
  web_search: 'web_search',
  web_extract: 'web_extract',
  notion_search: 'notion',
  'google-drive': 'google-drive',
  'google-ads': 'google-ads',
  google_ads_metrics: 'google-ads',
  'meta-ads': 'meta-ads',
  'google-analytics': 'google-analytics',
  analytics_report: 'google-analytics',
  'google-search-console': 'google-search-console',
  'google-business-profile': 'google-business-profile',
  daily_brief: 'daily_brief',
  cognee_memory_remember: 'cognee',
  slack: 'slack',
};

function providerFor(tool: string): string {
  if (TOOL_TO_PROVIDER[tool]) return TOOL_TO_PROVIDER[tool];
  if (tool.startsWith('google-drive')) return 'google-drive';
  if (tool.startsWith('notion')) return 'notion';
  return tool;
}

function roleAllowsTool(employeeName: string, tool: string): boolean {
  const seed = seedFor(employeeName);
  const merged = mergeRuntimeAllowlist([...seed.tool_allowlist], [], seed.role);
  const filtered = filterAllowlistForPersona(merged, seed.role);
  const t = norm(tool);
  const p = norm(providerFor(tool));
  const allowed = filtered.map(norm);
  if (allowed.includes(t) || allowed.includes(p)) return true;
  if (ALWAYS_ALLOWED_CORE_TOOLS.map(norm).includes(t) || ALWAYS_ALLOWED_CORE_TOOLS.map(norm).includes(p)) {
    return true;
  }
  return allowed.some(
    (a) =>
      t.startsWith(`${a}-`) ||
      a.startsWith(`${t}-`) ||
      p.startsWith(`${a}-`) ||
      a.startsWith(`${p}-`),
  );
}

function isRiskyToken(tool: string, action: string): boolean {
  // Underscores are word chars — match substrings, not \b word boundaries.
  return /(send|pay|refund|delete|charge|sign)/i.test(`${tool} ${action}`);
}

async function assertApprovalGated(tool: string, action: string, role: string): Promise<void> {
  const seed = DEFAULT_EMPLOYEE_ROSTER.find((e) => e.name === role || e.role === role);
  const denial = roleCapabilityDenial(role, tool, action, seed?.tool_allowlist);
  if (denial && /refund|delete|charge|payout/i.test(denial)) {
    expect(denial).toMatch(/cannot/i);
    return;
  }
  const verdict = await checkAutonomy({
    orgId: ORG,
    employeeRole: role,
    tool,
    action,
    confidence: 0.99,
  });
  expect(verdict.mode).toBe('approval_required');
  // Real gate — classify + DEFAULT_RULES / irreversible / confirmClasses path.
  const classified = resolveActionType(tool, action);
  expect(['irreversible', 'external_send', 'draft']).toContain(classified.bucket);
}

const ROWS: CapRow[] = [
  // ── Emma (Customer Support) ──────────────────────────────────────────
  {
    spec: 'customer-support',
    capability: 'Look up a customer across CRM, tickets, and payments',
    message: 'Look up Jane in HubSpot, Stripe, and Zendesk',
    kind: 'handoff',
    handoff: {
      fromRole: 'Customer Support',
      toRoleIncludes: /Customer Resolution/i,
    },
    tools: [],
  },
  {
    spec: 'customer-support',
    capability: 'Draft and send a reply (with approval)',
    message: "Reply on WhatsApp that we’re looking into her order",
    expectName: 'Emma',
    providers: ['gmail', 'whatsapp'],
    tools: ['gmail_draft_email', 'gmail_send', 'whatsapp_send'],
    risky: [
      { tool: 'whatsapp', action: 'send_message', role: 'Customer Support' },
      { tool: 'gmail', action: 'send_email', role: 'Customer Support' },
    ],
  },
  {
    spec: 'customer-support',
    capability: 'Refund (always approval)',
    message: "Process a refund for Jane’s last charge",
    kind: 'handoff',
    handoff: {
      fromRole: 'Customer Support',
      toRoleIncludes: /Customer Resolution/i,
    },
  },
  {
    spec: 'customer-support',
    capability: 'Open a ticket in Zendesk/Intercom',
    message: 'File an Intercom conversation for this bug',
    kind: 'handoff',
    handoff: {
      fromRole: 'Customer Support',
      toRoleIncludes: /Customer Resolution/i,
    },
  },
  {
    spec: 'customer-support',
    capability: 'Teach a knowledge gap to the Brain',
    message: 'Save this FAQ answer to org knowledge',
    expectName: 'Emma',
    tools: ['cognee_memory_remember'],
  },
  {
    spec: 'customer-support',
    capability: 'Open loops',
    message: "List open loops I’m responsible for",
    expectName: 'Emma',
    providers: ['customer-ops'],
    tools: ['customer_list_open_loops'],
  },
  {
    spec: 'customer-support',
    capability: 'At-risk conversations',
    message: 'Show at-risk support threads',
    expectName: 'Emma',
    providers: ['customer-ops'],
    tools: ['customer_list_at_risk'],
  },

  // ── Customer (Customer Resolution) ───────────────────────────────────
  {
    spec: 'customer-resolution',
    capability: 'Look up a customer across CRM, tickets, and payments',
    message: 'Pull the HubSpot + Stripe + recent ticket history for jane@acme.com',
    expectName: 'Customer',
    providers: ['hubspot', 'stripe', 'zendesk', 'intercom', 'database_query'],
    tools: ['hubspot_search_contacts', 'stripe_get_customer', 'zendesk_fetch_tickets', 'database_query'],
  },
  {
    spec: 'customer-resolution',
    capability: 'Draft and send a reply (with approval)',
    message: 'Draft a reply to the angry email from Jane, then send it after I approve',
    expectName: 'Customer',
    providers: ['gmail', 'whatsapp'],
    tools: ['gmail_draft_email', 'gmail_send', 'whatsapp_send'],
    risky: [{ tool: 'gmail', action: 'send_email', role: 'Customer Resolution' }],
  },
  {
    spec: 'customer-resolution',
    capability: 'Refund (always approval)',
    message: 'Refund charge ch_123 for order 88 under policy',
    expectName: 'Customer',
    providers: ['stripe'],
    tools: ['stripe_create_refund'],
    risky: [{ tool: 'stripe', action: 'create_refund', role: 'Customer Resolution' }],
  },
  {
    spec: 'customer-resolution',
    capability: 'Open a ticket in Zendesk/Intercom',
    message: "Open a Zendesk ticket for Jane’s shipping delay",
    expectName: 'Customer',
    providers: ['zendesk', 'intercom'],
    tools: ['zendesk_create_ticket', 'intercom_create_conversation'],
  },
  {
    spec: 'customer-resolution',
    capability: 'Teach a knowledge gap to the Brain',
    message: 'Remember: our return window is 14 days under $100',
    expectName: 'Customer',
    tools: ['cognee_memory_remember'],
  },
  {
    spec: 'customer-resolution',
    capability: 'Open loops',
    message: 'What open promises did we make to Jane this week?',
    expectName: 'Customer',
    providers: ['customer-ops'],
    tools: ['customer_list_open_loops'],
  },
  {
    spec: 'customer-resolution',
    capability: 'At-risk conversations',
    message: 'Which conversations are at risk right now?',
    expectName: 'Customer',
    providers: ['customer-ops'],
    tools: ['customer_list_at_risk'],
  },

  // ── Finance ──────────────────────────────────────────────────────────
  {
    spec: 'finance',
    capability: 'Stripe payment link',
    message: 'Create a Stripe payment link for $50',
    expectName: 'Finance',
    providers: ['stripe'],
    tools: ['stripe_create_payment_link'],
    risky: [{ tool: 'stripe', action: 'create_payment_link', role: 'Finance' }],
  },
  {
    spec: 'finance',
    capability: 'Razorpay payment link',
    message: 'Create a Razorpay payment link',
    expectName: 'Finance',
    providers: ['razorpay'],
    tools: ['razorpay_create_payment_link'],
    risky: [{ tool: 'razorpay', action: 'create_payment_link', role: 'Finance' }],
  },
  {
    spec: 'finance',
    capability: 'Create charge',
    message: 'Charge this card $100',
    expectName: 'Finance',
    providers: ['stripe'],
    tools: ['stripe_create_charge'],
    risky: [{ tool: 'stripe', action: 'create_charge', role: 'Finance' }],
  },
  {
    spec: 'finance',
    capability: 'Billing usage',
    message: "What's our billing usage / plan?",
    expectName: 'Finance',
    providers: ['billing_usage'],
    tools: ['billing_usage'],
  },
  {
    spec: 'finance',
    capability: 'QuickBooks invoices',
    message: 'List QuickBooks invoices',
    expectName: 'Finance',
    providers: ['quickbooks'],
    tools: ['quickbooks_list_invoices'],
  },
  {
    spec: 'finance',
    capability: 'Refund this',
    message: 'Refund order 88',
    kind: 'handoff',
    handoff: {
      fromRole: 'Finance',
      toRoleIncludes: /Customer/i,
    },
  },

  // ── Executive ────────────────────────────────────────────────────────
  {
    spec: 'executive',
    capability: 'Daily / morning brief in Ask AI',
    message: "Give me today’s executive brief",
    expectName: 'Executive',
    providers: ['daily_brief'],
    tools: ['daily_brief'],
  },
  {
    spec: 'executive',
    capability: 'Cross-domain status',
    message: "What’s the status across sales, support, and ops?",
    expectName: 'Executive',
    providers: ['daily_brief', 'database_query', 'web_search'],
    tools: ['daily_brief', 'database_query'],
  },
  {
    spec: 'executive',
    capability: 'Insights / unstructured analysis',
    message: 'What should I focus on this week?',
    expectName: 'Executive',
    providers: ['database_query', 'web_search', 'cognee'],
  },
  {
    spec: 'executive',
    capability: 'Founder / company questions',
    message: 'Tell me about the founders of darexai',
    kind: 'handoff',
    expectName: 'Research',
    tools: ['web_search', 'web_extract'],
  },
  {
    spec: 'executive',
    capability: 'Hand work to a specialist',
    message: 'Have Finance create a payment link',
    kind: 'handoff',
    handoff: {
      fromRole: 'Executive',
      toRoleIncludes: /Finance/i,
      message: 'Create a payment link for the invoice',
    },
  },
  {
    spec: 'executive',
    capability: 'Pick Executive in Ask AI mode selector',
    message: 'Pick one → Executive',
    kind: 'pick',
    expectName: 'Executive',
    providers: ['daily_brief', 'web_search', 'database_query', 'cognee'],
  },

  // ── Custom employee ──────────────────────────────────────────────────
  {
    spec: 'custom-employee',
    capability: 'Route by @mention / Ask-to',
    message: '@Maya draft a Slack update',
    kind: 'custom',
  },
  {
    spec: 'custom-employee',
    capability: 'Route by Auto keyword',
    message: 'Maya please audit the campaign spreadsheet',
    kind: 'custom',
  },
  {
    spec: 'custom-employee',
    capability: 'Call only card tools (product intent)',
    message: "Use only Maya’s tools",
    kind: 'custom',
  },
  {
    spec: 'custom-employee',
    capability: 'Empty allowlist hire',
    message: 'Hire with no tools checked',
    kind: 'custom',
  },
  {
    spec: 'custom-employee',
    capability: 'Persona defines behaviour',
    message: 'Custom system instructions on the card',
    kind: 'custom',
  },
  {
    spec: 'custom-employee',
    capability: 'Per-employee autonomy tiers',
    message: 'Custom hire with stricter send rules',
    kind: 'custom',
  },
  {
    spec: 'custom-employee',
    capability: 'Pick in Ask AI mode selector',
    message: 'Pick one → custom employee',
    kind: 'custom',
  },

  // ── Growth ───────────────────────────────────────────────────────────
  {
    spec: 'growth',
    capability: 'ICP / lookalikes',
    message: 'Find lookalike accounts for our ICP and shortlist VP Sales contacts',
    expectName: 'Growth',
    providers: ['apollo', 'hubspot'],
    tools: ['apollo_search_people', 'apollo_enrich_company'],
  },
  {
    spec: 'growth',
    capability: 'Buying signals',
    message: 'What buying signals do we have on Acme this week?',
    expectName: 'Growth',
    tools: ['web_search', 'web_extract'],
  },
  {
    spec: 'growth',
    capability: 'Dormant-lead revival',
    message: 'Revive dormant leads that just showed intent',
    expectName: 'Growth',
    providers: ['growth', 'gmail'],
    tools: ['growth_list_dormant_leads'],
  },
  {
    spec: 'growth',
    capability: 'Outreach drafts (approval)',
    message: "Draft outreach to the top lookalike — don't send",
    expectName: 'Growth',
    providers: ['gmail'],
    tools: ['gmail_draft_email'],
    risky: [{ tool: 'gmail', action: 'draft_email', role: 'Growth' }],
  },
  {
    spec: 'growth',
    capability: 'Pipeline attribution',
    message: 'Show pipeline attribution for Growth opportunities',
    expectName: 'Growth',
    providers: ['growth'],
    tools: ['growth_list_pipeline_attribution'],
  },
  {
    spec: 'growth',
    capability: 'ROI',
    message: "What's Growth pipeline ROI this month?",
    expectName: 'Growth',
    providers: ['growth'],
    tools: ['growth_pipeline_roi'],
  },

  // ── Marcus (Marketing & Analytics) ───────────────────────────────────
  {
    spec: 'marketing-analytics',
    capability: 'Google Ads metrics',
    message: 'Pull Google Ads performance for the last 7 days',
    expectName: 'Marcus',
    providers: ['google-ads'],
    tools: ['google-ads', 'google_ads_metrics'],
  },
  {
    spec: 'marketing-analytics',
    capability: 'Meta Ads metrics',
    message: 'Show Meta Ads ROAS / spend last week',
    expectName: 'Marcus',
    providers: ['meta-ads'],
    tools: ['meta-ads'],
  },
  {
    spec: 'marketing-analytics',
    capability: 'Google Analytics (GA4)',
    message: 'Run a GA4 report for property X',
    expectName: 'Marcus',
    providers: ['google-analytics'],
    tools: ['google-analytics', 'analytics_report'],
  },
  {
    spec: 'marketing-analytics',
    capability: 'Search Console',
    message: 'List Search Console sites',
    expectName: 'Marcus',
    providers: ['google-search-console'],
    tools: ['google-search-console'],
  },
  {
    spec: 'marketing-analytics',
    capability: 'Business Profile',
    message: 'List Google Business Profile locations',
    expectName: 'Marcus',
    providers: ['google-business-profile'],
    tools: ['google-business-profile'],
  },
  {
    spec: 'marketing-analytics',
    capability: 'Gmail',
    message: 'Draft a reply to this ad-lead email',
    expectName: 'Marcus',
    providers: ['gmail'],
    tools: ['gmail'],
    risky: [{ tool: 'gmail', action: 'send_email', role: 'Marketing & Analytics' }],
  },

  // ── Operations ───────────────────────────────────────────────────────
  {
    spec: 'operations',
    capability: 'Sheets + reconciliation',
    message: 'Reconcile this sheet against HubSpot contacts and flag mismatches.',
    expectName: 'Operations',
    providers: ['google-sheets', 'hubspot', 'database_query', 'operations'],
    tools: ['sheets_read', 'sheets_append_row', 'ops_reconcile_audit', 'database_query'],
  },
  {
    spec: 'operations',
    capability: 'Dedup CRM contacts',
    message: 'Find duplicate HubSpot contacts for Acme and merge safely.',
    expectName: 'Operations',
    providers: ['operations', 'hubspot'],
    tools: ['ops_dedup_contacts'],
  },
  {
    spec: 'operations',
    capability: 'Calendar deadlocks (Meet links, double-booking, unconfirmed guests)',
    message: "Audit tomorrow’s calendar for missing Meet links, overlaps, and unconfirmed guests.",
    expectName: 'Operations',
    providers: ['operations', 'google-calendar'],
    tools: ['ops_calendar_deadlocks', 'calendar_update_event'],
  },
  {
    spec: 'operations',
    capability: 'Meeting prep briefs',
    message: 'Prep briefs for all meetings tomorrow.',
    expectName: 'Operations',
    providers: ['operations'],
    tools: ['ops_meeting_prep'],
  },
  {
    spec: 'operations',
    capability: 'Work items — create',
    message: 'Create a high-priority work item for the stuck deal and assign Operations.',
    expectName: 'Operations',
    providers: ['operations'],
    tools: ['work_item_create'],
  },
  {
    spec: 'operations',
    capability: 'Work items — reassign',
    message: 'Reassign work item X to Emma.',
    expectName: 'Operations',
    providers: ['operations'],
    tools: ['work_item_reassign'],
  },
  {
    spec: 'operations',
    capability: 'Work items — priority',
    message: 'Bump that task to urgent.',
    expectName: 'Operations',
    providers: ['operations'],
    tools: ['work_item_set_priority'],
  },
  {
    spec: 'operations',
    capability: 'Expected-vs-actual discrepancies',
    message: 'Show open operational discrepancies / overdue expectations.',
    expectName: 'Operations',
    providers: ['operations'],
    tools: ['ops_list_discrepancies'],
  },
  {
    spec: 'operations',
    capability: 'Rent reminders',
    message: 'Draft rent reminders for leases due this week.',
    expectName: 'Operations',
    providers: ['operations'],
    tools: ['rent_reminders_list'],
  },
  {
    spec: 'operations',
    capability: 'Showings',
    message: 'Book a showing for listing L at Friday 3pm.',
    expectName: 'Operations',
    providers: ['re'],
    tools: ['re_showing_book'],
  },

  // ── Research ─────────────────────────────────────────────────────────
  {
    spec: 'research',
    capability: 'Web search with citations',
    message: 'Search the web for DareX AI competitors and cite sources',
    expectName: 'Research',
    tools: ['web_search', 'web_extract'],
  },
  {
    spec: 'research',
    capability: 'Deep extract after search',
    message: 'Open the top result and summarize the founding year',
    expectName: 'Research',
    tools: ['web_extract'],
  },
  {
    spec: 'research',
    capability: 'Company / founder questions (Auto)',
    message: 'who founded Acme Corp?',
    expectName: 'Research',
    tools: ['web_search', 'web_extract'],
  },
  {
    spec: 'research',
    capability: 'Search Drive / Notion and cite',
    message: 'Find our Q3 strategy doc in Drive and Notion and quote it',
    expectName: 'Research',
    providers: ['google-drive', 'notion'],
    tools: ['google-drive', 'notion_search'],
  },
  {
    spec: 'research',
    capability: 'Summarize findings into the Brain',
    message: 'Remember this competitive summary in org memory',
    expectName: 'Research',
    tools: ['cognee_memory_remember'],
  },
  {
    spec: 'research',
    capability: 'Comps / citation-heavy brief for another employee',
    message: 'Research comps for this deal then hand to Sarah',
    expectName: 'Research',
    tools: ['web_search', 'web_extract'],
    kind: 'handoff',
    handoff: {
      fromRole: 'Research',
      toRoleIncludes: /Finance|Customer|Operations/i,
      message: 'Please refund this charge after the research brief',
    },
  },

  // ── Sarah (Sales & Lead Gen) ─────────────────────────────────────────
  {
    spec: 'sales-lead-gen',
    capability: 'HubSpot contacts',
    message: 'Add Jane Doe at Acme as a HubSpot contact and set lifecycle to lead',
    expectName: 'Sarah',
    providers: ['hubspot'],
    tools: ['hubspot_create_contact', 'hubspot_update_contact'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'HubSpot deals',
    message: 'Create a HubSpot deal for Acme at $12k',
    expectName: 'Sarah',
    providers: ['hubspot'],
    tools: ['hubspot_list_deals', 'hubspot_create_deal', 'hubspot_update_deal'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Salesforce contacts / leads',
    message: 'List Salesforce contacts and create a lead for Acme',
    expectName: 'Sarah',
    providers: ['salesforce'],
    tools: ['salesforce_list_contacts', 'salesforce_create_contact', 'salesforce_create_lead'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Salesforce deals',
    message: 'Update the Acme opportunity stage in Salesforce',
    expectName: 'Sarah',
    providers: ['salesforce'],
    tools: ['salesforce_list_deals', 'salesforce_create_deal', 'salesforce_update_deal'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Zoho contacts / leads',
    message: 'Create a Zoho lead for this inbound',
    expectName: 'Sarah',
    providers: ['zoho-crm'],
    tools: ['zoho_list_contacts', 'zoho_create_contact', 'zoho_create_lead'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Zoho deals',
    message: 'Move Zoho deal to Proposal',
    expectName: 'Sarah',
    providers: ['zoho-crm'],
    tools: ['zoho_list_deals', 'zoho_create_deal', 'zoho_update_deal'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Apollo enrichment',
    message: 'Enrich Acme and find the VP Sales on Apollo',
    expectName: 'Sarah',
    providers: ['apollo'],
    tools: ['apollo_search_people', 'apollo_enrich_company'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'LinkedIn enrichment',
    message: 'Find this prospect on LinkedIn and pull company signals',
    expectName: 'Sarah',
    providers: ['linkedin'],
    tools: ['linkedin_search_people', 'linkedin_company_signals'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Schedule a meeting',
    message: 'Schedule a 30-min demo with jane@acme.com Thursday 3pm',
    expectName: 'Sarah',
    providers: ['google-calendar'],
    tools: ['calendar_create_event', 'calendar_check_availability', 'calendar_list_events'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Inquiry → listing match',
    message: 'Match open inquiries to new listings',
    expectName: 'Sarah',
    providers: ['re'],
    tools: ['re_inquiry_listing_match'],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Qualify / demo / pricing (dialogue)',
    message: 'Qualify this inbound and propose demo + pricing next steps',
    expectName: 'Sarah',
    providers: ['gmail', 'whatsapp', 'hubspot'],
    risky: [
      { tool: 'whatsapp', action: 'send_message', role: 'Sales & Lead Gen' },
      { tool: 'gmail', action: 'send_email', role: 'Sales & Lead Gen' },
    ],
  },
  {
    spec: 'sales-lead-gen',
    capability: 'Outreach send',
    message: 'Email the qualified lead the demo invite',
    expectName: 'Sarah',
    providers: ['gmail'],
    tools: ['gmail_send', 'gmail_draft_email'],
    risky: [{ tool: 'gmail', action: 'send_email', role: 'Sales & Lead Gen' }],
  },
];

// checkAutonomy reads per-org rules through withOrgClient. These rows assert
// the built-in DEFAULT_RULES gate, so make the rule lookup miss instantly
// instead of waiting on a real Postgres connect (flaky under parallel load).
jest.mock('@darex/workflows/dist/db', () => ({
  ...jest.requireActual('@darex/workflows/dist/db'),
  withOrgClient: jest.fn().mockRejectedValue(new Error('db disabled in unit test')),
}));

describe('employee capability rows (gap26sept/employees)', () => {
  // Rows that assert approval gating cold-load the tool executor, which
  // exceeds the 5s default when the whole monorepo suite runs in parallel.
  jest.setTimeout(30_000);
  const roster = fullRoster();

  for (const row of ROWS) {
    it(`${row.spec} — ${row.capability}`, async () => {
      if (row.kind === 'custom') {
        // Card allowlist + core only; empty card never inherits org connectors.
        const empty = allowlistForLockedEmployeeTurn([], ['stripe', 'gmail', 'hubspot'], 'Custom Analyst');
        expect(empty.map(norm)).not.toContain('stripe');
        expect(empty.map(norm)).not.toContain('gmail');
        expect(empty.some((t) => norm(t) === 'web-search' || norm(t) === 'web_search')).toBe(true);

        if (row.capability.startsWith('Route by @mention')) {
          const withMaya: RouteEmployee[] = [
            ...roster,
            {
              id: 'emp-maya',
              name: 'Maya',
              role: 'Ops Analyst',
              persona: 'Custom ops helper',
              toolAllowlist: ['slack'],
              status: 'active',
            },
          ];
          const locked = route({ orgId: ORG, userMessage: row.message, employees: withMaya });
          expect(locked.employeeName).toBe('Maya');
          expect(locked.locked).toBe(true);
        }

        if (row.capability.startsWith('Per-employee autonomy')) {
          await assertApprovalGated('gmail', 'send_email', 'Customer Support');
        }
        return;
      }

      if (row.kind === 'pick' && row.expectName === 'Executive') {
        const seed = seedFor('Executive');
        expect(seed.tool_allowlist).toEqual(
          expect.arrayContaining(['web_search', 'database_query', 'cognee', 'daily_brief']),
        );
        expect(seed.tool_allowlist).not.toContain('stripe');
        return;
      }

      if (row.kind === 'handoff' && row.handoff) {
        const msg = row.handoff.message ?? row.message;
        const hit = resolveLockedHandoff([row.handoff.fromRole], msg);
        expect(hit).not.toBeNull();
        expect(hit!.toRole).toMatch(row.handoff.toRoleIncludes);
        // Hand-off rows must not require the tool on the wrong role.
        if (row.handoff.fromRole === 'Customer Support') {
          const from = seedFor('Emma');
          if (/refund/i.test(row.capability) || /refund/i.test(msg)) {
            expect(from.tool_allowlist.map(norm)).not.toContain('stripe');
          }
          if (/ticket|Intercom|Zendesk|Look up|CRM/i.test(row.capability + msg)) {
            expect(from.tool_allowlist.map(norm)).not.toContain('zendesk');
            expect(from.tool_allowlist.map(norm)).not.toContain('intercom');
            expect(from.tool_allowlist.map(norm)).not.toContain('hubspot');
            expect(from.tool_allowlist.map(norm)).not.toContain('stripe');
          }
        }
        if (row.handoff.fromRole === 'Finance' && /refund/i.test(row.capability + msg)) {
          const from = seedFor('Finance');
          const denial = roleCapabilityDenial('Finance', 'stripe', 'create_refund', from.tool_allowlist);
          expect(denial).toMatch(/cannot/i);
        }
        // Founder → Research is Auto-routed (not a locked handoff).
        if (row.expectName === 'Research') {
          const result = route({ orgId: ORG, userMessage: row.message, employees: roster });
          expect(result.employeeName).toBe('Research');
        }
        return;
      }

      // Auto routing
      if (row.expectName || row.expectNames) {
        const result = route({ orgId: ORG, userMessage: row.message, employees: roster });
        const names = row.expectNames ?? (row.expectName ? [row.expectName] : []);
        expect(result.employeeName).toEqual(expect.stringMatching(new RegExp(`^(${names.map(escapeRegExp).join('|')})$`)));
      }

      const owner = row.expectName;
      if (owner && row.tools) {
        for (const tool of row.tools) {
          expect(roleAllowsTool(owner, tool)).toBe(true);
        }
      }
      if (owner && row.providers) {
        const seed = seedFor(owner);
        const merged = new Set(
          mergeRuntimeAllowlist([...seed.tool_allowlist], [], seed.role).map(norm),
        );
        for (const p of ALWAYS_ALLOWED_CORE_TOOLS) merged.add(norm(p));
        for (const provider of row.providers) {
          expect(merged.has(norm(provider)) || roleAllowsTool(owner, provider)).toBe(true);
        }
      }

      if (row.risky) {
        for (const r of row.risky) {
          if (isRiskyToken(r.tool, r.action) || /draft/i.test(r.action)) {
            await assertApprovalGated(r.tool, r.action, r.role);
          } else {
            throw new Error(`risky row missing send/pay/refund/delete/charge/sign: ${r.tool}.${r.action}`);
          }
        }
      }
    });
  }
});
