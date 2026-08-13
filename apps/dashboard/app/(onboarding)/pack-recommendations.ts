/**
 * Onboarding → pack + connector recommendations (U5 / P2).
 * Recommendations never imply a live OAuth connection.
 */

export interface RecommendedConnector {
  id: string;
  name: string;
  reason: string;
  connected: false;
}

export interface PackRecommendation {
  packIds: string[];
  label: string;
  connectors: RecommendedConnector[];
  copy: string;
}

const NOT_CONNECTED = false as const;

const CORE_B2B = 'core-b2b';

function connector(id: string, name: string, reason: string): RecommendedConnector {
  return { id, name, reason, connected: NOT_CONNECTED };
}

const SHEETS = connector('google-sheets', 'Google Sheets', 'Inventory / ops source of record');
const WHATSAPP = connector('whatsapp', 'WhatsApp Business', 'Inbound inquiries');
const GMAIL = connector('gmail', 'Gmail', 'Portal leads and follow-up');
const CALENDAR = connector('google-calendar', 'Google Calendar', 'Showings and bookings');
const HUBSPOT = connector('hubspot', 'HubSpot CRM', 'Pipeline (optional)');

const BY_TYPE: Record<string, PackRecommendation> = {
  'real estate — brokerage': {
    packIds: [CORE_B2B, 'real-estate-brokerage'],
    label: 'Core B2B + Real estate brokerage',
    connectors: [SHEETS, WHATSAPP, GMAIL, CALENDAR],
    copy: 'Recommended for a brokerage. Connectors stay disconnected until you finish OAuth.',
  },
  'real estate & property': {
    packIds: [CORE_B2B, 'real-estate-brokerage'],
    label: 'Core B2B + Real estate brokerage',
    connectors: [SHEETS, WHATSAPP, GMAIL, CALENDAR],
    copy: 'Recommended for a brokerage. Connectors stay disconnected until you finish OAuth.',
  },
  'e-commerce & retail': {
    packIds: [CORE_B2B, 'ecommerce'],
    label: 'Core B2B + Ecommerce',
    connectors: [GMAIL, WHATSAPP, HUBSPOT],
    copy: 'Recommended storefront stack. Nothing is marked connected.',
  },
  'software / saas': {
    packIds: [CORE_B2B, 'saas-gtm'],
    label: 'Core B2B + SaaS GTM',
    connectors: [GMAIL, CALENDAR, HUBSPOT],
    copy: 'Recommended GTM stack. Nothing is marked connected.',
  },
  'professional services / consulting': {
    packIds: [CORE_B2B, 'prof-services'],
    label: 'Core B2B + Professional services',
    connectors: [GMAIL, CALENDAR, WHATSAPP],
    copy: 'Recommended services stack. Nothing is marked connected.',
  },
  'marketing & creative agency': {
    packIds: [CORE_B2B, 'agencies'],
    label: 'Core B2B + Agencies',
    connectors: [GMAIL, WHATSAPP, HUBSPOT],
    copy: 'Recommended agency stack. Nothing is marked connected.',
  },
};

const FALLBACK: PackRecommendation = {
  packIds: [CORE_B2B],
  label: 'Core B2B',
  connectors: [GMAIL, WHATSAPP],
  copy: 'Default pack when the business type is other or unknown. Nothing is marked connected.',
};

export function normalizeBusinessType(raw: string | null | undefined): string {
  return (raw || '').trim().toLowerCase();
}

export function isRealEstateBrokerage(businessType: string | null | undefined): boolean {
  const key = normalizeBusinessType(businessType);
  return (
    key.includes('real estate') ||
    key.includes('realtor') ||
    key.includes('brokerage') ||
    key.includes('property')
  );
}

export function recommendPacksForBusinessType(businessType: string | null | undefined): PackRecommendation {
  const key = normalizeBusinessType(businessType);
  if (!key) return FALLBACK;
  if (BY_TYPE[key]) return BY_TYPE[key];
  if (isRealEstateBrokerage(key)) return BY_TYPE['real estate — brokerage'];
  if (key.includes('e-commerce') || key.includes('ecommerce') || key.includes('retail')) {
    return BY_TYPE['e-commerce & retail'];
  }
  if (key.includes('saas') || key.includes('software')) return BY_TYPE['software / saas'];
  if (key.includes('consult') || key.includes('professional')) {
    return BY_TYPE['professional services / consulting'];
  }
  if (key.includes('agency') || key.includes('marketing')) return BY_TYPE['marketing & creative agency'];
  return FALLBACK;
}

export function recommendationPayload(businessType: string | null | undefined) {
  const rec = recommendPacksForBusinessType(businessType);
  return {
    recommendedPacks: rec.packIds,
    recommendedPackLabel: rec.label,
    recommendedConnectors: rec.connectors.map((c) => ({
      id: c.id,
      name: c.name,
      reason: c.reason,
      connected: false as const,
    })),
    recommendationCopy: rec.copy,
  };
}
