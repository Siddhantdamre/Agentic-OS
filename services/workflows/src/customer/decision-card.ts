import type { DecisionCard } from '@darex/shared-types';
export function lowConfidenceDecisionCard(input: {
  customer: string; situation: string; policy?: string; recommendation?: string;
}): DecisionCard {
  return {
    title: 'Needs a decision',
    customer: input.customer,
    situation: input.situation,
    policy: input.policy || 'Low retrieval confidence and no matching tool result.',
    recommendation: input.recommendation || 'Review the thread and reply, or approve a holding answer.',
    options: [
      { id: 'approve', label: 'Approve holding reply', cost: 'Customer waits on us' },
      { id: 'takeover', label: 'Take over the thread', cost: 'You reply now' },
    ],
    status: 'open',
  };
}
