/**
 * Runtime pack manifests. Keep in sync with packs/<slug>/pack.yaml.
 * YAML on disk is the human source of truth; this module is what install uses
 * without a YAML parser dependency.
 */

import type { PackEmployeeTemplate, PackManifest } from '@darex/shared-types';

/**
 * `database_query` is granted to every role whose standing duty is to look at
 * its own workspace.
 *
 * These allowlists were written for a world of external tools — gmail,
 * whatsapp, hubspot — and never included the tool for reading the tenant's own
 * records. The consequence only became visible once employees were given
 * duties: four of eight could not perform their own job on their own data, and
 * `planDuty` correctly reported them as NOT PERMITTED. "Who asked and never got
 * an answer" is a question about this workspace's own conversations, and a
 * sales agent that cannot ask it is not a sales agent.
 *
 * A smaller grant than it looks. The tool validates SELECT or WITH only, one
 * statement, auto-limited, run through an org-scoped client — so row-level
 * security confines it to this tenant even if the SQL it wrote would have
 * reached further. And a duty runs with the minimum tool rather than the
 * employee's full allowlist, so holding this does not widen what the employee
 * may do inside a customer conversation.
 */
/**
 * PERSONAS SAY WHAT OUTSTANDING LOOKS LIKE, NOT ONLY WHAT IS FORBIDDEN.
 *
 * Every persona here used to be a prohibition and nothing else - six roles, six
 * variants of "never invent X". The prohibitions were earned and all of them
 * remain. What was missing is the other half: an agent told only what NOT to
 * say optimises toward saying little, and safe-but-empty is exactly the GAVE UP
 * column the completion suite counts, where the records held the answer and the
 * agent declined anyway.
 *
 * Each role now also states what a good answer from THAT role contains, in
 * terms specific enough to act on: which question a sales agent asks first,
 * that an ops number carries its period, that a showing coordinator offers
 * slots rather than asking when suits. The shared mechanical rules - money
 * symbols, separators, answer-first, length - live once in the system prompt's
 * output standard rather than being repeated in six places.
 */
export const CORE_B2B_EMPLOYEES: PackEmployeeTemplate[] = [
  {
    name: 'Sarah',
    role: 'Sales / front-of-house',
    personaTemplate:
      'Sales specialist, warm and direct. Outstanding work from you: qualify a lead by '
      + 'asking the ONE question that decides fit, quote real prices with the ₹ symbol '
      + 'and separators, and always close with a concrete next step and a time. Never '
      + 'invent pipeline amounts.',
    toolAllowlist: ['gmail', 'whatsapp', 'hubspot', 'google-calendar', 'web_search', 'database_query'],
  },
  {
    name: 'Emma',
    role: 'Support / success',
    personaTemplate:
      'Support agent, empathetic but specific. Outstanding work from you: name the exact '
      + 'policy, window or figure from the records rather than reassuring in general terms, '
      + 'and tell the customer what happens next and when. Sympathy without a fact is not '
      + 'support. Answer from memory and tickets. Never invent order status.',
    toolAllowlist: ['gmail', 'whatsapp', 'google-calendar', 'database_query'],
  },
  {
    name: 'Marcus',
    role: 'Ops / analyst',
    personaTemplate:
      'Ops analyst. Outstanding work from you: every number carries its unit and the '
      + 'period it covers, and you say what the number MEANS for the business, not just '
      + 'what it is. An empty result is a finding - report "no orders recorded in that '
      + 'period" and never let it become a zero presented as performance. Sheets, Drive '
      + 'and metrics.query only. Never invent KPIs.',
    toolAllowlist: ['google-sheets', 'google-drive', 'metrics', 'web_search'],
  },
];

export const RE_BROKERAGE_EMPLOYEES: PackEmployeeTemplate[] = [
  {
    name: 'Aisha',
    role: 'Buyer ISA',
    personaTemplate:
      'Buyer ISA. Outstanding work from you: establish budget, location and timeline in '
      + 'as few questions as possible - one at a time - then match against real inventory '
      + 'and quote prices with ₹ and separators. Filters first. Never invent inventory, '
      + 'price, or RERA.',
    toolAllowlist: ['whatsapp', 'gmail', 'google-calendar', 're', 'google-sheets', 'database_query'],
  },
  {
    name: 'Kabir',
    role: 'Showing coordinator',
    personaTemplate:
      'Showing coordinator. Outstanding work from you: offer specific slots with day, date '
      + 'and time rather than asking when suits, confirm the address and travel detail '
      + 'unprompted, and never ask the customer for the business\'s own address. Book on '
      + 'Calendar when connected. Disconnected Calendar is notConnected. Never invent a '
      + 'booked slot.',
    toolAllowlist: ['google-calendar', 'whatsapp', 'gmail', 're'],
  },
  {
    name: 'Meera',
    role: 'Listing coordinator',
    personaTemplate:
      'Listing coordinator. Outstanding work from you: state every field with its unit - '
      + 'area in sq ft, price with ₹ and separators - and name precisely which fields are '
      + 'still missing rather than reporting the listing as incomplete. New listing '
      + 'checklist from source fields only. Never invent price, area, or RERA.',
    toolAllowlist: ['google-drive', 'google-docs', 'gmail', 'google-sheets', 're', 'database_query'],
  },
];

export const PACK_MANIFESTS: Record<string, PackManifest> = {
  'core-b2b': {
    id: 'core-b2b',
    name: 'Core B2B',
    version: '1.0.0',
    markets: ['IN', 'US', 'AE', 'GB'],
    entities: ['contact', 'company', 'deal', 'ticket', 'document', 'event', 'invoice'],
    connectors: {
      required: [],
      recommended: ['gmail', 'whatsapp', 'google-calendar'],
      optional: ['hubspot', 'google-sheets', 'google-drive', 'slack', 'stripe', 'razorpay'],
    },
    employees: CORE_B2B_EMPLOYEES,
    workflows: [
      { temporalWorkflowName: 'OwnerBriefingWorkflow', triggers: ['daily'] },
      { temporalWorkflowName: 'StaleChaseWorkflow', triggers: ['scheduled'] },
    ],
    entitySchemas: [],
    kpis: [{ id: 'core.inquiries_unworked' }, { id: 'core.needs_attention' }],
    onboardingCopy: 'Default pack for every org. Connectors stay disconnected until OAuth.',
  },
  'real-estate-brokerage': {
    id: 'real-estate-brokerage',
    name: 'Real estate brokerage',
    version: '1.0.0',
    extends: 'core-b2b',
    markets: ['IN', 'US'],
    entities: ['re.listing', 're.inquiry', 're.showing'],
    connectors: {
      required: [],
      recommended: ['google-sheets', 'whatsapp', 'gmail', 'google-calendar'],
      optional: ['hubspot', 'google-drive', 'google-business-profile', 'maps'],
    },
    employees: RE_BROKERAGE_EMPLOYEES,
    workflows: [
      { temporalWorkflowName: 'ShowingScheduleWorkflow', triggers: ['inquiry.book_showing'] },
      { temporalWorkflowName: 'RentReminderWorkflow', triggers: ['pm.charge.due'] },
    ],
    entitySchemas: [],
    kpis: [{ id: 're.inquiries_24h' }, { id: 're.showings_this_week' }],
    onboardingCopy:
      'India wedge: Sheets + WhatsApp + Gmail + Calendar. Never invent price, RERA, or inventory.',
  },
};

export const LIVE_PACK_IDS = ['core-b2b', 'real-estate-brokerage'] as const;

export function isLivePackId(packId: string): packId is (typeof LIVE_PACK_IDS)[number] {
  return (LIVE_PACK_IDS as readonly string[]).includes(packId);
}
