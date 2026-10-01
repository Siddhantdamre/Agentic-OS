/** Deterministic demo seed. Inputs only — never pre-extracted outcomes. */

export const DEMO_ORG = '00000000-0000-4000-8000-00000000d3e0';

export const ACME = { name: 'Acme Ltd', tier: 'key' as const, history: 14 };
export const BRIGHT = { name: 'Bright Home', tier: 'standard' as const, history: 2 };

export function hoursAgo(hours: number, from = Date.now()): Date {
  return new Date(from - hours * 60 * 60 * 1000);
}

export const DEMO_ENQUIRY = {
  customer: BRIGHT.name,
  state: 'new' as const,
  slaExpiresAt: hoursAgo(6),
};

export const DEMO_MESSAGES = [
  {
    customer: ACME.name,
    speaker: 'us' as const,
    content: "I'll send the revised quote by Tuesday.",
    at: hoursAgo(12 * 24),
  },
  {
    customer: ACME.name,
    speaker: 'them' as const,
    content: 'Order #4837 was 6 days late. I want a full refund.',
    at: hoursAgo(2),
  },
  {
    customer: BRIGHT.name,
    speaker: 'us' as const,
    content: "I'll confirm the delivery date shortly.",
    at: hoursAgo(2 * 24),
  },
];
