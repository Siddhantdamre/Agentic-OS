import { proxyActivities, ApplicationFailure } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export interface MemoryWriteBackInput {
  orgId: string;
  workItemId?: string;
  conversationId: string;
  transcriptExcerpt?: string;
  toolResults?: unknown;
  closed?: boolean;
  businessKey?: string;
}

export interface MemoryWriteBackResult {
  written: boolean;
  factCount: number;
  skippedDuplicates: number;
  fieldUpdatesApplied: number;
  needsAttention: boolean;
  openQuestionCount: number;
  noOp?: boolean;
}

const { memoryWriteBackActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '3 minutes',
  scheduleToCloseTimeout: '8 minutes',
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
 * Child workflow for post-turn memory write-back (M4).
 * Parent (WorkItemWorkflow) starts this off the webhook HTTP thread and
 * must not await it on inbound. Hash-idempotent facts; low-confidence
 * extracts become needs_attention, never silent list_price.
 */
export async function MemoryWriteBackWorkflow(
  input: MemoryWriteBackInput
): Promise<MemoryWriteBackResult> {
  requireOrgId(input.orgId);
  return memoryWriteBackActivity(input);
}
