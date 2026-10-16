import type { HandoffRule } from './types';

/**
 * Operations employee hand-off rules for locked Ask AI turns.
 * G1 owns handoffs/index.ts wiring; this file exports the real Ops rules.
 */
export const rules: HandoffRule[] = [
  {
    fromRoleIncludes: ['operation', 'ops'],
    patterns: [/\b(refund|return|chargeback)\b/i],
    toRole: 'Customer',
    reason: 'Refunds and returns are owned by Customer Resolution, not Operations.',
  },
  {
    fromRoleIncludes: ['operation', 'ops'],
    patterns: [/\b(payment link|invoice|charge|payout|stripe|razorpay)\b/i],
    toRole: 'Finance',
    reason: 'Payment links, invoices, and charges hand off to Finance.',
  },
  {
    fromRoleIncludes: ['operation', 'ops'],
    patterns: [/\b(ad[s]?|campaign|roas|meta ads|google ads)\b/i],
    toRole: 'Marketing & Analytics',
    reason: 'Ads and campaign performance hand off to Marcus / Marketing & Analytics.',
  },
  {
    fromRoleIncludes: ['operation', 'ops'],
    patterns: [/\b(prospect|outreach|apollo|lookalike|pipeline|deal|lead gen)\b/i],
    toRole: 'Sales & Lead Gen',
    reason: 'Prospecting and deals hand off to Sales (or Growth for lookalikes/pipeline strategy).',
  },
  {
    fromRoleIncludes: ['operation', 'ops'],
    patterns: [/\b(research|founder|who (is|founded)|company (overview|background)|look up .+ online)\b/i],
    toRole: 'Research',
    reason: 'Web research and company/founder questions hand off to Research.',
  },
];
