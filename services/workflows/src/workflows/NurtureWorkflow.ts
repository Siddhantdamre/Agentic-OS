import {
  ApplicationFailure,
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { NurtureCancelReason, NurtureTick } from '../quiet-hours.js';

export type { NurtureCancelReason, NurtureTick };

export interface NurtureWorkflowInput {
  orgId: string;
  conversationId: string;
  contactId?: string;
  channel?: 'whatsapp' | 'email';
  timeZone?: string;
  /** Skip quiet hours only when an explicit emergency policy is set. */
  emergencyPolicy?: boolean;
  template?: string;
  idempotencyKey?: string;
}

export interface NurtureWorkflowResult {
  orgId: string;
  conversationId: string;
  status: 'completed' | 'cancelled';
  reason?: NurtureCancelReason | string;
  sent: NurtureTick[];
}

export const cancelNurtureSignal = defineSignal<[NurtureCancelReason?]>('cancelNurture');

const NURTURE_DELAYS: ReadonlyArray<{ tick: NurtureTick; ms: number }> = [
  { tick: 'T+1d', ms: 1 * 24 * 60 * 60 * 1000 },
  { tick: 'T+3d', ms: 3 * 24 * 60 * 60 * 1000 },
  { tick: 'T+7d', ms: 7 * 24 * 60 * 60 * 1000 },
];

const {
  nurtureGateActivity,
  sendNurtureMessageActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '6 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

/**
 * Long-running nurture (O6): Temporal sleep T+1/3/7d. Cancel on inbound reply
 * or human takeover. Respect do-not-contact and quiet hours (no 2am blasts
 * unless emergencyPolicy).
 */
export async function NurtureWorkflow(input: NurtureWorkflowInput): Promise<NurtureWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  const conversationId = input.conversationId;
  if (!conversationId) {
    throw ApplicationFailure.nonRetryable('conversationId is required', 'InvalidArgumentError');
  }

  let cancelled: NurtureCancelReason | undefined;
  setHandler(cancelNurtureSignal, (reason) => {
    cancelled = reason || 'inbound';
  });

  const sent: NurtureTick[] = [];
  let elapsed = 0;
  const startedAt = Date.now();

  for (const step of NURTURE_DELAYS) {
    const wait = step.ms - elapsed;
    if (wait > 0) {
      await condition(() => cancelled !== undefined, wait);
    }
    elapsed = step.ms;
    if (cancelled) {
      return { orgId, conversationId, status: 'cancelled', reason: cancelled, sent };
    }

    let gate = await nurtureGateActivity({
      orgId,
      conversationId,
      startedAt,
      timeZone: input.timeZone || 'UTC',
      emergencyPolicy: input.emergencyPolicy === true,
      businessKey: `${input.idempotencyKey || conversationId}:gate:${step.tick}`,
    });

    while (gate.action === 'sleep_quiet' && !cancelled) {
      await condition(() => cancelled !== undefined, Math.max(gate.waitMs, 60_000));
      if (cancelled) {
        return { orgId, conversationId, status: 'cancelled', reason: cancelled, sent };
      }
      gate = await nurtureGateActivity({
        orgId,
        conversationId,
        startedAt,
        timeZone: input.timeZone || 'UTC',
        emergencyPolicy: input.emergencyPolicy === true,
        businessKey: `${input.idempotencyKey || conversationId}:gate:${step.tick}:quiet`,
      });
    }

    switch (gate.action) {
      case 'cancel':
        return {
          orgId,
          conversationId,
          status: 'cancelled',
          reason: (gate.reason as NurtureCancelReason | undefined) || 'inbound',
          sent,
        };
      case 'sleep_quiet':
        break;
      case 'send': {
        const result = await sendNurtureMessageActivity({
          orgId,
          conversationId,
          contactId: input.contactId || gate.contactId,
          channel: input.channel || 'whatsapp',
          tick: step.tick,
          template: input.template,
          businessKey: `${input.idempotencyKey || conversationId}:send:${step.tick}`,
        });
        if (result.sent) sent.push(step.tick);
        break;
      }
      default: {
        const _exhaustive: never = gate.action;
        void _exhaustive;
        break;
      }
    }
  }

  return { orgId, conversationId, status: 'completed', sent };
}
