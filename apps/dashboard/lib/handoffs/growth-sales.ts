import type { HandoffRule } from './types';

/**
 * Growth ↔ Sales hand-off rules for Ask AI locked / pick-one mode.
 * Offer the target employee; do not execute out-of-scope tools.
 */
export const rules: HandoffRule[] = [
  {
    fromRoleIncludes: ['growth'],
    patterns: [/\b(refund|return|chargeback|ticket|post[- ]?sale support)\b/i],
    toRole: 'Customer',
    reason: 'Refunds and post-sale support belong to Customer.',
  },
  {
    fromRoleIncludes: ['growth'],
    patterns: [/\b(ad|ads|campaign|roas|google[- ]?ads|meta[- ]?ads)\b/i],
    toRole: 'Marketing',
    reason: 'Paid ads and campaign spend belong to Marketing.',
  },
  {
    fromRoleIncludes: ['growth'],
    patterns: [/\b(invoice|payment link|bookkeep|books|payout)\b/i],
    toRole: 'Finance',
    reason: 'Books, invoices, and payment links belong to Finance.',
  },
  {
    fromRoleIncludes: ['growth'],
    patterns: [/\b(demo|pricing|qualify|inbound lead|sales call)\b/i],
    toRole: 'Sarah',
    reason: 'Demo, pricing, and named inbound qualification belong to Sales (Sarah).',
  },
  {
    fromRoleIncludes: ['growth'],
    patterns: [/\b(research|founder|cite|web research|company research|who founded)\b/i],
    toRole: 'Research',
    reason: 'Company, founder, and cite-heavy web research belong to Research.',
  },
  {
    fromRoleIncludes: ['sales', 'lead gen', 'sarah'],
    patterns: [/\b(refund|return|chargeback|ticket|order status)\b/i],
    toRole: 'Customer',
    reason: 'Refunds and support tickets belong to Customer.',
  },
  {
    fromRoleIncludes: ['sales', 'lead gen', 'sarah'],
    patterns: [/\b(payment link|invoice|collect payment|razorpay|stripe link)\b|\bcharges?\b/i],
    toRole: 'Finance',
    reason: 'Payment links, invoices, and charges belong to Finance. Refunds stay with Customer.',
  },
  {
    fromRoleIncludes: ['sales', 'lead gen', 'sarah'],
    patterns: [/\b(ad|ads|campaign|roas|google[- ]?ads|meta[- ]?ads)\b/i],
    toRole: 'Marketing',
    reason: 'Paid ads belong to Marketing.',
  },
  {
    fromRoleIncludes: ['sales', 'lead gen', 'sarah'],
    patterns: [/\b(reconcil|dedup|sheets audit|meeting[- ]?prep ops)\b/i],
    toRole: 'Operations',
    reason: 'Reconciliation and ops hygiene belong to Operations.',
  },
  {
    fromRoleIncludes: ['sales', 'lead gen', 'sarah'],
    patterns: [/\b(lookalike|buying signal|icp|dormant|apollo scout)\b/i],
    toRole: 'Growth',
    reason: 'Lookalikes, signals, and dormant revival belong to Growth.',
  },
];

export type GrowthSalesFrom = 'growth' | 'sales';

/** First matching rule for a locked persona + user message, or null. */
export function matchHandoff(
  from: GrowthSalesFrom,
  message: string,
): { to: string; reason: string } | null {
  const roleLabel = from === 'growth' ? 'Growth' : 'Sales & Lead Gen';
  for (const rule of rules) {
    if (!rule.fromRoleIncludes.some((frag) => roleLabel.toLowerCase().includes(frag.toLowerCase()))) {
      continue;
    }
    if (!rule.patterns.some((p) => p.test(message))) continue;
    return { to: rule.toRole, reason: rule.reason };
  }
  return null;
}
