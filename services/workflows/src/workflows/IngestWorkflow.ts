/**
 * SUPERVISION: not-agent-work — parses and stores an uploaded or synced
 * document. Its outcomes are recorded as skip reasons on the document
 * itself.
 */
import { proxyActivities, ApplicationFailure } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export type IngestConnector = 'drive' | 'upload' | 'google-drive';

export type IngestSkipReason = 'kyc' | 'empty' | 'hash' | 'virus' | 'parse' | 'not_connected';

export type IngestWorkflowStatus = 'enqueued' | 'skipped' | 'failed' | 'pending';

export interface IngestWorkflowInput {
  orgId: string;
  jobId?: string;
  sourceId?: string;
  connector?: IngestConnector;
  path?: string;
  fileId?: string;
  mimeType?: string;
  kind?: string | null;
  dataClass?: string | null;
  modifiedAt?: string | null;
}

export interface IngestWorkflowResult {
  orgId: string;
  sourceId?: string;
  jobId?: string;
  status: IngestWorkflowStatus;
  skipReason?: IngestSkipReason;
  path?: string;
  modifiedAt?: string;
  chunkCount?: number;
  embedJobs?: string[];
  error?: string;
  connected?: boolean;
  setupUrl?: string;
}

const { ingestFileActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  scheduleToCloseTimeout: '30 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 5,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      'AuthorizationError',
      'InvalidArgumentError',
      'NotConnectedError',
      'KycSkipError',
      'ParseUnavailableError',
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
 * File ingest (K1/K2). Virus-scan stub → parse → chunk → enqueue EmbedWorkflow.
 * Never runs on the Ask AI / webhook HTTP thread. Callers must not await embed.
 */
export async function IngestWorkflow(input: IngestWorkflowInput): Promise<IngestWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  const result = await ingestFileActivity({
    orgId,
    jobId: input.jobId,
    sourceId: input.sourceId,
    connector: input.connector,
    path: input.path,
    fileId: input.fileId,
    mimeType: input.mimeType,
    kind: input.kind,
    dataClass: input.dataClass,
    modifiedAt: input.modifiedAt,
  });
  return { ...result, orgId };
}
