import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export interface DsrDeleteWorkflowInput {
  orgId: string;
  dsrRequestId: string;
  requestedByUserId: string | null;
}

export interface DsrDeleteWorkflowResult {
  dsrRequestId: string;
  status: 'completed';
  deleted: Record<string, number>;
}

const { runDsrDeleteActivity, markDsrRequestFailedActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  scheduleToCloseTimeout: '45 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 5,
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
 * Async GDPR delete. Per-table progress is stored on dsr_requests so activity
 * retries resume; if all retries fail the row is marked failed (never stuck
 * running forever).
 */
export async function DsrDeleteWorkflow(
  input: DsrDeleteWorkflowInput
): Promise<DsrDeleteWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  if (!input.dsrRequestId) {
    throw ApplicationFailure.nonRetryable('dsrRequestId is required', 'InvalidArgumentError');
  }
  try {
    return await runDsrDeleteActivity({
      orgId,
      dsrRequestId: input.dsrRequestId,
      requestedByUserId: input.requestedByUserId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await markDsrRequestFailedActivity({
      orgId,
      dsrRequestId: input.dsrRequestId,
      error: message,
    });
    throw err;
  }
}
