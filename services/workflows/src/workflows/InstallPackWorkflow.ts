/**
 * SUPERVISION: not-agent-work — provisions employees from a role pack at
 * setup time. An operator is present by definition.
 */
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { InstallPackWorkflowInput, InstallPackWorkflowResult } from '@darex/shared-types';

const { installPackActivity } = proxyActivities<typeof activities>({
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
 * Idempotent pack install (P1). Re-install of an already-installed pack is a
 * no-op. Uninstall is a separate activity and never deletes conversations.
 */
export async function InstallPackWorkflow(
  input: InstallPackWorkflowInput
): Promise<InstallPackWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  const packId = input.packId;
  if (!packId) {
    throw ApplicationFailure.nonRetryable('packId is required', 'InvalidArgumentError');
  }
  return installPackActivity({
    orgId,
    packId,
    idempotencyKey: input.idempotencyKey || `install-pack:${orgId}:${packId}`,
  });
}
