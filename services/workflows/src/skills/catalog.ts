/**
 * First-party skill catalog for the agent runtime.
 * Keep tool names aligned with apps/dashboard skills page and mcp-bridge TOOLS.
 *
 * Skills are capability bundles: a skill is "ready" for an org only when every
 * required connector provider appears in that org's connected channels.
 * Tools from non-ready skills are never injected into the allowlist.
 */

export type FirstPartySkill = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** MCP / catalog tool names (mcp.darex.* or bare keys). */
  requiresTools: string[];
  /** Connector providers that must be connected for this skill to load. */
  requiresProviders: string[];
  /** Minimum employee autonomy_tier (1–4) required to execute this skill's tools. */
  minAutonomyLevel: 1 | 2 | 3 | 4;
};

export const FIRST_PARTY_SKILLS: FirstPartySkill[] = [
  {
    id: 'calendar-playbook',
    name: 'Google Calendar',
    version: '1.0.0',
    description: 'List events, create events, free/busy.',
    requiresTools: ['calendar_list_events', 'calendar_create_event', 'google-calendar'],
    requiresProviders: ['google-calendar'],
    minAutonomyLevel: 2,
  },
  {
    id: 'gmail-playbook',
    name: 'Gmail',
    version: '1.0.0',
    description: 'Fetch, triage, draft, and send mail.',
    requiresTools: ['gmail_fetch', 'gmail_send', 'gmail'],
    requiresProviders: ['gmail'],
    minAutonomyLevel: 2,
  },
  {
    id: 'sheets-playbook',
    name: 'Google Sheets',
    version: '1.0.0',
    description: 'Read/write spreadsheet rows used as a system of record.',
    requiresTools: ['sheets_read', 'sheets_append_row', 'google-sheets'],
    requiresProviders: ['google-sheets'],
    minAutonomyLevel: 2,
  },
  {
    id: 'docs-playbook',
    name: 'Google Docs',
    version: '1.0.0',
    description: 'Read and draft Google Docs.',
    requiresTools: ['docs_create', 'docs_read', 'google-docs'],
    requiresProviders: ['google-docs'],
    minAutonomyLevel: 2,
  },
  {
    id: 'drive-playbook',
    name: 'Google Drive',
    version: '1.0.0',
    description: 'List and fetch Drive files.',
    requiresTools: ['drive_search', 'drive_get_text', 'google-drive'],
    requiresProviders: ['google-drive'],
    minAutonomyLevel: 1,
  },
  {
    id: 'notion-playbook',
    name: 'Notion',
    version: '1.0.0',
    description: 'Search and update Notion pages.',
    requiresTools: ['notion_search', 'notion'],
    requiresProviders: ['notion'],
    minAutonomyLevel: 2,
  },
  {
    id: 'sales-crm',
    name: 'Sales CRM',
    version: '1.0.0',
    description: 'HubSpot / CRM contact and deal operations.',
    requiresTools: ['hubspot_create_contact', 'hubspot_update_contact', 'hubspot'],
    requiresProviders: ['hubspot'],
    minAutonomyLevel: 3,
  },
  {
    id: 'support-tickets',
    name: 'Support tickets',
    version: '1.0.0',
    description: 'Inbox and ticket playbooks.',
    requiresTools: ['zendesk_fetch_tickets', 'intercom_fetch_conversations', 'zendesk', 'intercom'],
    requiresProviders: ['zendesk', 'intercom'],
    minAutonomyLevel: 2,
  },
  {
    id: 'ecommerce',
    name: 'E-commerce',
    version: '1.0.0',
    description: 'Shopify products and orders.',
    requiresTools: ['shopify_fetch_products', 'shopify_fetch_orders', 'shopify'],
    requiresProviders: ['shopify'],
    minAutonomyLevel: 2,
  },
  {
    id: 'payments',
    name: 'Org payment links',
    version: '1.0.0',
    description: 'Stripe/Razorpay payment links for the tenant.',
    requiresTools: ['stripe_create_payment_link', 'razorpay_create_payment_link', 'stripe', 'razorpay'],
    requiresProviders: ['stripe', 'razorpay'],
    minAutonomyLevel: 4,
  },
  {
    id: 'whatsapp-playbook',
    name: 'WhatsApp messaging',
    version: '1.0.0',
    description: 'Send and triage WhatsApp conversations.',
    requiresTools: ['whatsapp_send', 'whatsapp'],
    requiresProviders: ['whatsapp'],
    minAutonomyLevel: 3,
  },
];

/** Highest minAutonomyLevel among skills that list this tool. */
export function minAutonomyForTool(toolOrName: string): number {
  const key = normalizeProvider(toolOrName);
  let min = 1;
  for (const skill of FIRST_PARTY_SKILLS) {
    const hit = skill.requiresTools.some((t) => normalizeProvider(t) === key);
    if (hit && skill.minAutonomyLevel > min) min = skill.minAutonomyLevel;
  }
  return min;
}

function normalizeProvider(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^mcp\.darex\./, '')
    .replace(/_/g, '-');
}

/**
 * Skills whose every required provider is present in the org's connected set.
 * support-tickets / payments require ANY of their providers (OR), not all —
 * gated via requiresProvidersAll=false semantics below.
 */
export function readySkillsForOrg(connectedChannels: string[]): FirstPartySkill[] {
  const connected = new Set(connectedChannels.map(normalizeProvider).filter(Boolean));
  return FIRST_PARTY_SKILLS.filter((skill) => {
    // A skill is ready when at least one required provider is connected.
    // Multi-provider skills (support, payments) should not require every vendor.
    return skill.requiresProviders.some((p) => connected.has(normalizeProvider(p)));
  });
}

/** Tool keys to inject into the org allowlist from ready skills only. */
export function toolsFromConnectedSkills(connectedChannels: string[]): string[] {
  const tools = new Set<string>();
  for (const skill of readySkillsForOrg(connectedChannels)) {
    for (const t of skill.requiresTools) {
      tools.add(normalizeProvider(t));
    }
  }
  return Array.from(tools);
}

/**
 * Filter a candidate tool catalog to tools allowed by the org/employee allowlist
 * or always-allowed core tools. Used by in-process TrueForge toolset selection.
 */
export function filterCatalogByAllowlist<T extends { name: string; tool: string }>(
  catalog: T[],
  allowlist: string[] | undefined,
  coreTools: string[]
): T[] {
  if (!allowlist || allowlist.length === 0) {
    const core = new Set(coreTools.map(normalizeProvider));
    return catalog.filter(
      (t) => core.has(normalizeProvider(t.name)) || core.has(normalizeProvider(t.tool))
    );
  }
  const allowed = new Set(allowlist.map(normalizeProvider));
  const core = new Set(coreTools.map(normalizeProvider));
  return catalog.filter((t) => {
    const n = normalizeProvider(t.name);
    const p = normalizeProvider(t.tool);
    return core.has(n) || core.has(p) || allowed.has(n) || allowed.has(p);
  });
}
