/**
 * SUPERVISION: GAP — sends a payment reminder about a real amount to a real
 * tenant.
 */
import { ApplicationFailure, proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export interface RentReminderWorkflowInput {
  orgId: string;
  chargeId: string;
  leaseId?: string;
  /** Tenant free-text “I paid” must NOT close the charge. */
  tenantClaimedPaid?: boolean;
  pspPaymentId?: string;
  idempotencyKey?: string;
}

export interface RentReminderWorkflowResult {
  orgId: string;
  chargeId: string;
  reminded: boolean;
  closed: boolean;
  claimedPaid: boolean;
  message: string;
}

const { rentReminderActivity } = proxyActivities<typeof activities>({
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
 * PM rent reminder (P4 cheap). Sends a reminder; never closes a charge on a
 * tenant “I paid” claim. Close only via PSP webhook id or human_confirm.
 */
export async function RentReminderWorkflow(
  input: RentReminderWorkflowInput
): Promise<RentReminderWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  if (!input.chargeId) {
    throw ApplicationFailure.nonRetryable('chargeId is required', 'InvalidArgumentError');
  }
  const result = await rentReminderActivity({
    orgId,
    chargeId: input.chargeId,
    tenantClaimedPaid: input.tenantClaimedPaid === true,
    pspPaymentId: input.pspPaymentId,
    businessKey: input.idempotencyKey || `rent:${orgId}:${input.chargeId}`,
  });
  if (!result.closed) {
    await sleep('1s');
  }
  return result;
}
