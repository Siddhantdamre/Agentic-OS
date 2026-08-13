import { proxyActivities, ApplicationFailure } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export type EmbedSkipReason = 'hash' | 'kyc' | 'empty';

export type EmbedWorkflowStatus = 'embedded' | 'skipped' | 'failed';

export interface EmbedWorkflowInput {
  orgId: string;
  jobId?: string;
}

export interface EmbedWorkflowResult {
  orgId: string;
  jobId?: string;
  status: EmbedWorkflowStatus;
  skipReason?: EmbedSkipReason;
  memoryId?: string;
  processed?: number;
  error?: string;
}

const { embedIngestionJobActivity, embedQueuedJobsActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  scheduleToCloseTimeout: '15 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 5,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      'AuthorizationError',
      'InvalidArgumentError',
      'ConfigurationError',
      'EmbeddingDimMismatch',
    ],
  },
});

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

/**
 * Durable embed worker (M2). Never runs on the WhatsApp/Chatwoot HTTP thread.
 * Callers enqueue via `enqueueEmbedJob` and must not await this workflow's result.
 */
export async function EmbedWorkflow(input: EmbedWorkflowInput): Promise<EmbedWorkflowResult> {
  const orgId = requireOrgId(input.orgId);

  if (input.jobId) {
    const one = await embedIngestionJobActivity({ orgId, jobId: input.jobId });
    await embedQueuedJobsActivity({ orgId, limit: 64 });
    return { ...one, orgId, jobId: input.jobId };
  }

  const drained = await embedQueuedJobsActivity({ orgId, limit: 128 });
  return { ...drained, orgId };
}
