import { ApplicationFailure } from '@temporalio/activity';
import { withOrgClient } from '../db.js';
import { markDsrRequestFailed, runDsrDelete, type RunDsrDeleteResult } from '../dsr/run-delete.js';
import { runDsrExport, type RunDsrExportResult } from '../dsr/run-export.js';

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

function requireRequestId(dsrRequestId: string | undefined): string {
  if (!dsrRequestId) {
    throw ApplicationFailure.nonRetryable('dsrRequestId is required', 'InvalidArgumentError');
  }
  return dsrRequestId;
}

export async function runDsrDeleteActivity(params: {
  orgId: string;
  dsrRequestId: string;
  requestedByUserId: string | null;
}): Promise<RunDsrDeleteResult> {
  const orgId = requireOrgId(params.orgId);
  const dsrRequestId = requireRequestId(params.dsrRequestId);
  return withOrgClient(orgId, (client) =>
    runDsrDelete(client, {
      orgId,
      dsrRequestId,
      requestedByUserId: params.requestedByUserId,
    })
  );
}

export async function runDsrExportActivity(params: {
  orgId: string;
  dsrRequestId: string;
  requestedByUserId: string | null;
}): Promise<RunDsrExportResult> {
  const orgId = requireOrgId(params.orgId);
  const dsrRequestId = requireRequestId(params.dsrRequestId);
  return withOrgClient(orgId, (client) =>
    runDsrExport(client, {
      orgId,
      dsrRequestId,
      requestedByUserId: params.requestedByUserId,
    })
  );
}

export async function markDsrRequestFailedActivity(params: {
  orgId: string;
  dsrRequestId: string;
  error: string;
}): Promise<void> {
  const orgId = requireOrgId(params.orgId);
  const dsrRequestId = requireRequestId(params.dsrRequestId);
  await withOrgClient(orgId, (client) =>
    markDsrRequestFailed(client, {
      orgId,
      dsrRequestId,
      error: params.error,
    })
  );
}
