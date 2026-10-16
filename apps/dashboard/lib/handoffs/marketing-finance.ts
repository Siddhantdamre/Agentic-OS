import type { HandoffRule } from './types';

/**
 * Hand-off rules for Marcus (Marketing & Analytics) and Finance.
 * Consumed by the ask-ai handoff layer when wired — do not invent routes here.
 */
export const rules: HandoffRule[] = [
  {
    fromRoleIncludes: ['finance', 'cfo', 'bookkeep'],
    patterns: [/\b(refund|return|chargeback)\b/i],
    toRole: 'Customer',
    reason: 'Refunds belong to Customer — Finance never pays out refunds.',
  },
  {
    fromRoleIncludes: ['marketing', 'analytics', 'marcus'],
    patterns: [/\b(payment\s*link|invoice|payout|create\s+charge|charge\s+(this|the|a|card))\b/i],
    toRole: 'Finance',
    reason: 'Marketing does not send payment links or create charges — Finance owns pay.',
  },
  {
    fromRoleIncludes: ['marketing', 'analytics', 'marcus'],
    patterns: [/\b(reconcil|crm\s*dedup|dedup(e|licate)?\s+(contact|crm|hubspot)|pipeline\s+reconcil)\b/i],
    toRole: 'Operations',
    reason: 'CRM reconciliation belongs to Operations, not Marketing.',
  },
];
