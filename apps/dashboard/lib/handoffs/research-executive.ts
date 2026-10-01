import type { HandoffRule } from './types';

/**
 * Hand-off rules for Executive and Research.
 * Consumed by prompt / routing docs — do not widen allowlists from these rules.
 */
export const rules: HandoffRule[] = [
  {
    fromRoleIncludes: ['executive'],
    patterns: [/\b(refund|return|chargeback|ticket|order status|support follow[- ]?up)\b/i],
    toRole: 'Customer',
    reason: 'Refunds, tickets, and support follow-ups belong to Customer.',
  },
  {
    fromRoleIncludes: ['executive'],
    patterns: [/\b(sheet|calendar deadlock|work item|reconcil)\b/i],
    toRole: 'Operations',
    reason: 'Sheets, calendar deadlocks, work items, and reconciliation belong to Operations.',
  },
  {
    fromRoleIncludes: ['executive'],
    patterns: [/\b(pipeline|lookalike|buying signal|website visitor)\b/i],
    toRole: 'Growth',
    reason: 'Pipeline, lookalikes, and buying signals belong to Growth.',
  },
  {
    fromRoleIncludes: ['executive'],
    patterns: [/\b(deal|demo|outreach|sales call|meeting)\b/i],
    toRole: 'Sales',
    reason: 'Deals, meetings, demos, and outreach belong to Sales.',
  },
  {
    fromRoleIncludes: ['executive'],
    patterns: [/\b(ad|ads|roas|campaign)\b/i],
    toRole: 'Marketing',
    reason: 'Ads and campaign analytics belong to Marketing.',
  },
  {
    fromRoleIncludes: ['executive'],
    patterns: [/\b(payment link|invoice)\b/i],
    toRole: 'Finance',
    reason: 'Payment links and invoices belong to Finance (not refunds).',
  },
  {
    fromRoleIncludes: ['executive'],
    patterns: [/\b(research|founder|cite|web research|who founded)\b/i],
    toRole: 'Research',
    reason: 'Sources, founder/company facts, and cite-heavy web work belong to Research.',
  },
  {
    fromRoleIncludes: ['research'],
    patterns: [/\b(payment link|pay|invoice|charge)\b/i],
    toRole: 'Finance',
    reason: 'Pay and payment links belong to Finance.',
  },
  {
    fromRoleIncludes: ['research'],
    patterns: [/\b(refund|return|ticket)\b/i],
    toRole: 'Customer',
    reason: 'Refunds and tickets belong to Customer.',
  },
  {
    fromRoleIncludes: ['research'],
    patterns: [/\b(reconcil|sheet|work item)\b/i],
    toRole: 'Operations',
    reason: 'Reconciliation and work items belong to Operations.',
  },
];
