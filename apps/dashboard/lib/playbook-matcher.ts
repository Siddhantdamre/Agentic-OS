/**
 * Named playbook matcher (O6). High-confidence hits skip free-form plan
 * generation and still confirm irreversible steps. Greetings never match.
 * Fan-out is capped — a "hi" does not spawn a crew.
 */

import type { GeneratedPlan, PlanStep } from '@darex/shared-types';

export const PLAYBOOK_IDS = [
  're.inquiry_to_showing',
  're.new_listing_checklist',
  'pm.rent_reminder',
  'ecom.wismo',
  'core.stale_deal_chase',
] as const;

export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

export const PLAYBOOK_MATCH_THRESHOLD = 0.8;

const GREETING_RE = /^\s*(hi|hello|hey|yo|thanks|thank you|good\s?(morning|afternoon|evening))[\s!.?]*$/i;

export interface PlaybookDefinition {
  id: PlaybookId;
  title: string;
  summary: string;
  keywords: RegExp;
  steps: PlanStep[];
  draft: string;
  reasoning: string;
}

function step(
  id: string,
  description: string,
  tool: string,
  action: string,
  payload: Record<string, unknown> = {}
): PlanStep {
  return { id, description, tool, action, payload, enabled: true };
}

export const PLAYBOOKS: readonly PlaybookDefinition[] = [
  {
    id: 're.inquiry_to_showing',
    title: 'Inquiry to showing',
    summary: 'Qualify the inquiry, propose a showing, draft the reply — send stays confirm-gated.',
    keywords: /\b(showing|site visit|come\s+see|book\s+(a\s+)?visit|2bhk|3bhk|inquiry\s+to\s+showing|schedule\s+(a\s+)?(visit|showing|viewing))\b/i,
    reasoning: 'Matched playbook re.inquiry_to_showing. Irreversible send still needs PlanCard approve.',
    draft: '',
    steps: [
      step('pb-1', 'Look up matching listings from the inventory sheet', 'google-sheets', 'sheets_read', {}),
      step('pb-2', 'Check calendar availability for a showing', 'google-calendar', 'list_events', {}),
      step('pb-3', 'Draft a showing proposal email (do not send yet)', 'gmail', 'draft_email', {}),
    ],
  },
  {
    id: 're.new_listing_checklist',
    title: 'New listing checklist',
    summary: 'Create the listing checklist doc and sheet row. Publish/send stays confirm-gated.',
    keywords: /\b(new\s+listing|list\s+(this\s+)?propert|listing\s+checklist|onboard\s+(a\s+)?listing)\b/i,
    reasoning: 'Matched playbook re.new_listing_checklist.',
    draft: '',
    steps: [
      step('pb-1', 'Create a listing checklist Google Doc', 'google-docs', 'docs_create', {}),
      step('pb-2', 'Append the listing row to the inventory sheet', 'google-sheets', 'sheets_append_row', {}),
    ],
  },
  {
    id: 'pm.rent_reminder',
    title: 'Rent reminder',
    summary: 'Draft a rent reminder. Send is confirm-gated and must respect quiet hours.',
    keywords: /\b(rent\s+reminder|overdue\s+rent|chase\s+rent|rent\s+due)\b/i,
    reasoning: 'Matched playbook pm.rent_reminder. Outbound send requires approval.',
    draft: '',
    steps: [
      step('pb-1', 'Find the tenant conversation and due amount from SQL metrics', 'metrics', 'query', {
        metricIds: ['core.needs_attention'],
      }),
      step('pb-2', 'Draft the rent reminder (do not send yet)', 'gmail', 'draft_email', {}),
    ],
  },
  {
    id: 'ecom.wismo',
    title: 'Where is my order',
    summary: 'Look up the order and draft a tracking reply. No unbounded customer fan-out.',
    keywords: /\b(where\s+is\s+my\s+order|wismo|order\s+status|tracking\s+(number|id)|shipment\s+status)\b/i,
    reasoning: 'Matched playbook ecom.wismo.',
    draft: '',
    steps: [
      step('pb-1', 'Fetch the Shopify order by id or email', 'shopify', 'fetch_orders', {}),
      step('pb-2', 'Draft a tracking reply (do not send yet)', 'gmail', 'draft_email', {}),
    ],
  },
  {
    id: 'core.stale_deal_chase',
    title: 'Stale deal chase',
    summary: 'Flag unworked inquiries from SQL metrics. Does not spawn a crew of 8.',
    keywords: /\b(stale\s+deal|unworked\s+inquir|chase\s+(the\s+)?leads?|follow\s+up\s+on\s+stale)\b/i,
    reasoning: 'Matched playbook core.stale_deal_chase. Counts come from metrics.query, not raw message scans.',
    draft: '',
    steps: [
      step('pb-1', 'Count unworked inquiries from the metrics registry', 'metrics', 'query', {
        metricIds: ['core.inquiries_unworked', 'core.needs_attention'],
      }),
      step('pb-2', 'Draft a chase note for the owner (do not blast contacts)', 'gmail', 'draft_email', {}),
    ],
  },
];

function isPlaybookId(value: string): value is PlaybookId {
  return (PLAYBOOK_IDS as readonly string[]).includes(value);
}

export function getPlaybook(id: string | null | undefined): PlaybookDefinition | null {
  if (!id || !isPlaybookId(id)) return null;
  return PLAYBOOKS.find((p) => p.id === id) || null;
}

export interface PlaybookMatch {
  playbookId: PlaybookId;
  confidence: number;
  playbook: PlaybookDefinition;
}

/**
 * Returns a named playbook when confidence is high. Greetings and short
 * chit-chat return null so "hi" cannot fan out into agents.
 */
export function matchPlaybook(prompt: string): PlaybookMatch | null {
  const trimmed = (prompt || '').trim();
  if (!trimmed || GREETING_RE.test(trimmed)) return null;
  if (trimmed.length < 12) return null;

  let best: PlaybookMatch | null = null;
  for (const playbook of PLAYBOOKS) {
    if (!playbook.keywords.test(trimmed)) continue;
    const confidence = trimmed.length < 80 ? 0.88 : 0.82;
    if (!best || confidence > best.confidence) {
      best = { playbookId: playbook.id, confidence, playbook };
    }
  }
  if (!best || best.confidence < PLAYBOOK_MATCH_THRESHOLD) return null;
  return best;
}

export function playbookToPlan(playbook: PlaybookDefinition, prompt: string): GeneratedPlan {
  return {
    reasoning: `${playbook.reasoning} User asked: ${prompt.slice(0, 180)}`,
    steps: playbook.steps.map((s) => ({ ...s, payload: { ...(s.payload || {}) } })),
    draft: playbook.draft,
    summary: playbook.summary,
  };
}
