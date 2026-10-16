import { ApplicationFailure, proxyActivities, startChild, ParentClosePolicy } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import { MAX_NURTURE_FANOUT, MAX_STALE_CHASE, nurtureWorkflowId } from '../quiet-hours.js';
import { NurtureWorkflow } from './NurtureWorkflow.js';

export interface StaleChaseWorkflowInput {
  orgId: string;
  timeZone?: string;
  slaHours?: number;
  idempotencyKey?: string;
}

export interface StaleChaseWorkflowResult {
  orgId: string;
  flagged: number;
  chased: number;
  skipped: number;
  gaps: string[];
}

const { listStaleConversationsActivity, markStaleNeedsAttentionActivity } = proxyActivities<typeof activities>({
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
 * Threshold chase for inquiries/deals/tickets with no outbound inside SLA (O5).
 * Fan-out is capped. Does not spawn a crew from a model-produced list.
 */
export async function StaleChaseWorkflow(
  input: StaleChaseWorkflowInput
): Promise<StaleChaseWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  const slaHours = input.slaHours && input.slaHours > 0 ? input.slaHours : 2;

  const listed = await listStaleConversationsActivity({
    orgId,
    slaHours,
    limit: MAX_STALE_CHASE,
    businessKey: input.idempotencyKey || `stale:${orgId}`,
  });

  let flagged = 0;
  let chased = 0;
  let skipped = 0;
  const nurtureCandidates: typeof listed.conversations = [];

  for (const conv of listed.conversations) {
    if (conv.hasOutboundInSla) {
      skipped += 1;
      continue;
    }
    await markStaleNeedsAttentionActivity({
      orgId,
      conversationId: conv.conversationId,
      workItemId: conv.workItemId,
      reason: `No outbound reply within ${slaHours}h SLA`,
      businessKey: `${input.idempotencyKey || orgId}:flag:${conv.conversationId}`,
    });
    flagged += 1;
    if (conv.channel === 'whatsapp' && conv.contactId && !conv.doNotContact) {
      nurtureCandidates.push(conv);
    }
  }

  const capped = nurtureCandidates.slice(0, MAX_NURTURE_FANOUT);
  skipped += Math.max(0, nurtureCandidates.length - capped.length);

  for (const conv of capped) {
    try {
      await startChild(NurtureWorkflow, {
        workflowId: nurtureWorkflowId(orgId, conv.conversationId),
        args: [
          {
            orgId,
            conversationId: conv.conversationId,
            contactId: conv.contactId,
            channel: 'whatsapp',
            timeZone: input.timeZone || 'UTC',
            idempotencyKey: `${input.idempotencyKey || orgId}:nurture:${conv.conversationId}`,
          },
        ],
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
        workflowExecutionTimeout: '14 days',
      });
      chased += 1;
    } catch {
      skipped += 1;
    }
  }

  return { orgId, flagged, chased, skipped, gaps: listed.gaps };
}
