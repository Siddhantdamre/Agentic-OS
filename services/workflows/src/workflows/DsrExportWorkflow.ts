import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export interface DsrExportWorkflowInput {
  orgId: string;
  dsrRequestId: string;
  requestedByUserId: string | null;
}

export interface DsrExportWorkflowResult {
  dsrRequestId: string;
  status: 'completed';
  artifactPath?: string;
  downloadPath?: string;
  counts?: Record<string, number>;
}

const { runDsrExportActivity, markDsrRequestFailedActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  scheduleToCloseTimeout: '45 minutes',
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
 * Async GDPR export. Writes a JSON artifact under DSR_ARTIFACT_DIR and stores
 * the relative path on dsr_requests for /api/dsr/:id/download.
 */
export async function DsrExportWorkflow(
  input: DsrExportWorkflowInput
): Promise<DsrExportWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  if (!input.dsrRequestId) {
    throw ApplicationFailure.nonRetryable('dsrRequestId is required', 'InvalidArgumentError');
  }
  try {
    const result = await runDsrExportActivity({
      orgId,
      dsrRequestId: input.dsrRequestId,
      requestedByUserId: input.requestedByUserId,
    });
    return {
      dsrRequestId: result.dsrRequestId,
      status: 'completed',
      artifactPath: result.artifactPath,
      downloadPath: result.downloadPath,
      counts: result.counts,
    };
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
