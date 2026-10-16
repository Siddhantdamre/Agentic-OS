/**
 * Cold-start ramp (22). New orgs notice first, then draft, then reversible
 * internal acts, then gated external sends. Backfill is read-only and never
 * chases historical promises.
 */

export type ColdStartPhase = 'notice' | 'draft' | 'act_internal' | 'act_external';

export interface ColdStartPolicy {
  phase: ColdStartPhase;
  autonomyEnabled: boolean;
  externalSendsEnabled: boolean;
  backfillChases: boolean;
  maxOutboundPerCustomerDay: number;
}

export function coldStartPhase(orgAgeDays: number): ColdStartPhase {
  if (orgAgeDays < 7) return 'notice';
  if (orgAgeDays < 14) return 'draft';
  if (orgAgeDays < 21) return 'act_internal';
  return 'act_external';
}

export function coldStartPolicy(orgAgeDays: number): ColdStartPolicy {
  const phase = coldStartPhase(orgAgeDays);
  return {
    phase,
    autonomyEnabled: phase === 'act_internal' || phase === 'act_external',
    externalSendsEnabled: phase === 'act_external',
    backfillChases: false,
    maxOutboundPerCustomerDay: phase === 'notice' ? 0 : phase === 'draft' ? 0 : 3,
  };
}

export const DEFAULT_AUTONOMY_SEED: ReadonlyArray<{
  action_type: string;
  autonomy_tier: number;
  reversibility: 'reversible' | 'visible' | 'irreversible';
  requires_human_approval: boolean;
}> = [
  { action_type: 'read_*', autonomy_tier: 1, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'search_*', autonomy_tier: 1, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'list_*', autonomy_tier: 1, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'create_task', autonomy_tier: 3, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'assign_owner', autonomy_tier: 3, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'update_field', autonomy_tier: 3, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'update_status', autonomy_tier: 4, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'send_internal_reminder', autonomy_tier: 4, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'answer_faq', autonomy_tier: 4, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'draft_email', autonomy_tier: 2, reversibility: 'reversible', requires_human_approval: true },
  { action_type: 'prepare_brief', autonomy_tier: 2, reversibility: 'reversible', requires_human_approval: false },
  { action_type: 'recommend_merge', autonomy_tier: 2, reversibility: 'reversible', requires_human_approval: true },
  { action_type: 'reschedule_appointment', autonomy_tier: 3, reversibility: 'visible', requires_human_approval: false },
  { action_type: 'send_external_email', autonomy_tier: 2, reversibility: 'visible', requires_human_approval: true },
  { action_type: 'send_external_message', autonomy_tier: 2, reversibility: 'visible', requires_human_approval: true },
  { action_type: 'refund_payment', autonomy_tier: 2, reversibility: 'irreversible', requires_human_approval: true },
  { action_type: 'delete_record', autonomy_tier: 2, reversibility: 'irreversible', requires_human_approval: true },
];

/** Historical imports never trigger a chase. */
export function backfillLoopStatus(isGenuinelyLive: boolean): 'waiting' | 'closed' {
  return isGenuinelyLive ? 'waiting' : 'closed';
}

/**
 * Seed initial cold-start policy for an org at onboarding.
 */
export function seedColdStart(orgAgeDays: number = 0): ColdStartPolicy {
  return coldStartPolicy(orgAgeDays);
}
