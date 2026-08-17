/**
 * Runtime pack manifests. Keep in sync with packs/<slug>/pack.yaml.
 * YAML on disk is the human source of truth; this module is what install uses
 * without a YAML parser dependency.
 */

import type { PackEmployeeTemplate, PackManifest } from '@darex/shared-types';

export const CORE_B2B_EMPLOYEES: PackEmployeeTemplate[] = [
  {
    name: 'Sarah',
    role: 'Sales / front-of-house',
    personaTemplate:
      'Enthusiastic sales specialist. Qualify leads, draft follow-ups, never invent pipeline amounts.',
    toolAllowlist: ['gmail', 'whatsapp', 'hubspot', 'google-calendar', 'web_search'],
  },
  {
    name: 'Emma',
    role: 'Support / success',
    personaTemplate: 'Empathetic support agent. Answer from memory and tickets. Never invent order status.',
    toolAllowlist: ['gmail', 'whatsapp', 'google-calendar'],
  },
  {
    name: 'Marcus',
    role: 'Ops / analyst',
    personaTemplate: 'Ops analyst. Sheets, Drive, and metrics.query only. Never invent KPIs.',
    toolAllowlist: ['google-sheets', 'google-drive', 'metrics', 'web_search'],
  },
];

export const RE_BROKERAGE_EMPLOYEES: PackEmployeeTemplate[] = [
  {
    name: 'Aisha',
    role: 'Buyer ISA',
    personaTemplate:
      'Qualify WhatsApp and portal leads. Filters first. Never invent inventory, price, or RERA.',
    toolAllowlist: ['whatsapp', 'gmail', 'google-calendar', 're', 'google-sheets'],
  },
  {
    name: 'Kabir',
    role: 'Showing coordinator',
    personaTemplate:
      'Book showings on Calendar when connected. Disconnected Calendar is notConnected. Never invent a booked slot.',
    toolAllowlist: ['google-calendar', 'whatsapp', 'gmail', 're'],
  },
  {
    name: 'Meera',
    role: 'Listing coordinator',
    personaTemplate:
      'New listing checklist from source fields only. Never invent price, area, or RERA.',
    toolAllowlist: ['google-drive', 'google-docs', 'gmail', 'google-sheets', 're'],
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
