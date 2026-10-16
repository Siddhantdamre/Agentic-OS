import type { HandoffRule } from './types';

/**
 * Customer Resolution + Customer Support hand-off rules.
 * Emma (Customer Support) → Customer for refunds / tickets / CRM-payments.
 * Customer → Finance / Operations / Growth-Sales for work she does not own.
 */
export const rules: HandoffRule[] = [
  {
    fromRoleIncludes: ['customer support'],
    patterns: [
      /\b(refund|refunds|chargeback|charge[\s-]?back|return(s)?\b.*\border|money[\s-]?back)\b/i,
    ],
    toRole: 'Customer Resolution',
    reason: 'Refunds and returns are owned by Customer Resolution, not front-line support.',
  },
  {
    fromRoleIncludes: ['customer support'],
    patterns: [
      /\b(zendesk|intercom|helpdesk|open\s+(a\s+)?ticket|file\s+(a\s+)?ticket|create\s+(a\s+)?ticket)\b/i,
    ],
    toRole: 'Customer Resolution',
    reason: 'Ticket systems (Zendesk/Intercom) are owned by Customer Resolution.',
  },
  {
    fromRoleIncludes: ['customer support'],
    patterns: [
      /\b(hubspot|stripe|crm|payment(s)?\s+lookup|look\s*up\s+(the\s+)?(customer|charge|invoice)|order\s+status)\b/i,
    ],
    toRole: 'Customer Resolution',
    reason: 'CRM and payments lookup are owned by Customer Resolution.',
  },
  {
    fromRoleIncludes: ['customer resolution'],
    patterns: [
      /\b(payment\s+link|invoice|razorpay|collect\s+payment|send\s+(a\s+)?bill)\b/i,
    ],
    toRole: 'Finance',
    reason: 'Payment links and invoices are owned by Finance.',
  },
  {
    fromRoleIncludes: ['customer resolution'],
    patterns: [
      /\b(spreadsheet|google[\s-]?sheets?|reconcil|dedup|de-dup|deduplicate)\b/i,
    ],
    toRole: 'Operations',
    reason: 'Spreadsheet reconciliation and dedup are owned by Operations.',
  },
  {
    fromRoleIncludes: ['customer resolution'],
    patterns: [
      /\b(prospect|outreach|pipeline|lead\s+gen|lookalike|buying\s+signal)\b/i,
    ],
    toRole: 'Growth',
    reason: 'Prospecting and pipeline work belong to Growth or Sales.',
  },
];
