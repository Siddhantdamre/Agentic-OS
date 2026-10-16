import { proxyActivities, executeChild, ApplicationFailure } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import { IngestWorkflow } from './IngestWorkflow.js';

export type SyncConnectorKey = 'google-drive' | 'google-sheets' | 'hubspot';

export type SyncWorkflowStatus = 'synced' | 'not_connected' | 'failed';

export interface SyncWorkflowInput {
  orgId: string;
  connectorKey: SyncConnectorKey;
  stream: string;
}

export interface SyncWorkflowResult {
  orgId: string;
  connectorKey: string;
  stream: string;
  status: SyncWorkflowStatus;
  upserted: number;
  skipped: number;
  conflicts: number;
  cursor?: string | null;
  ingestStarted: number;
  error?: string;
  connected?: boolean;
  setupUrl?: string;
}

const { syncConnectorActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  scheduleToCloseTimeout: '30 minutes',
  retry: {
    initialInterval: '3s',
    maximumAttempts: 5,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      'AuthorizationError',
      'InvalidArgumentError',
      'NotConnectedError',
    ],
  },
});

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

function assertConnectorKey(key: string): SyncConnectorKey {
  switch (key) {
    case 'google-drive':
    case 'google-sheets':
    case 'hubspot':
      return key;
    default: {
      const _exhaustive: never = key as never;
      throw ApplicationFailure.nonRetryable(
        `Unsupported sync connector: ${String(_exhaustive)}`,
        'InvalidArgumentError',
      );
    }
  }
}

/**
 * Incremental connector sync (K3). Cursors are per org+connector+stream.
 * Idempotent on source_ref. Disconnected Drive returns notConnected — no fake folders.
 * Sheets vs CRM hash mismatch is marked `conflict`, never silently picked.
 */
export async function SyncWorkflow(input: SyncWorkflowInput): Promise<SyncWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  const connectorKey = assertConnectorKey(input.connectorKey);
  const stream = (input.stream || 'files').trim() || 'files';

  const listed = await syncConnectorActivity({
    orgId,
    connectorKey,
    stream,
  });

  if (listed.status === 'not_connected') {
    return {
      orgId,
      connectorKey,
      stream,
      status: 'not_connected',
      upserted: 0,
      skipped: 0,
      conflicts: listed.conflicts,
      cursor: listed.cursor,
      ingestStarted: 0,
      error: listed.error,
      connected: false,
      setupUrl: listed.setupUrl || '/connectors',
    };
  }

  if (listed.status === 'failed') {
    return {
      orgId,
      connectorKey,
      stream,
      status: 'failed',
      upserted: listed.upserted,
      skipped: listed.skipped,
      conflicts: listed.conflicts,
      cursor: listed.cursor,
      ingestStarted: 0,
      error: listed.error,
      connected: listed.connected,
    };
  }

  const pending = listed.pendingIngest || [];
  const started = await Promise.all(
    pending.map((item) =>
      executeChild(IngestWorkflow, {
        workflowId: `ingest-${orgId}-${item.sourceId}`,
        taskQueue: 'darex-agent-tasks',
        args: [{
          orgId,
          sourceId: item.sourceId,
          jobId: item.jobId,
          connector: item.connector,
          path: item.path,
          fileId: item.fileId,
          mimeType: item.mimeType,
          kind: item.kind,
          modifiedAt: item.modifiedAt,
        }],
        workflowExecutionTimeout: '30 minutes',
      }).then(() => true).catch(() => false),
    ),
  );

  return {
    orgId,
    connectorKey,
    stream,
    status: 'synced',
    upserted: listed.upserted,
    skipped: listed.skipped,
    conflicts: listed.conflicts,
    cursor: listed.cursor,
    ingestStarted: started.filter(Boolean).length,
    connected: true,
  };
}
