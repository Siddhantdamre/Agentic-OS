/**
 * SUPERVISION: GAP — schedules a viewing with a real person at a real time.
 */
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export interface ShowingScheduleWorkflowInput {
  orgId: string;
  listingId?: string;
  inquiryId?: string;
  startTime: string;
  endTime?: string;
  summary?: string;
  idempotencyKey?: string;
}

export interface ShowingScheduleWorkflowResult {
  orgId: string;
  booked: boolean;
  connected: boolean;
  setupUrl?: string;
  showingId?: string;
  conflict?: boolean;
  message: string;
}

const { bookShowingActivity } = proxyActivities<typeof activities>({
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
 * Book a showing on Calendar when connected. Otherwise notConnected — never
 * invent a booked slot. Memory write-back happens inside the activity.
 */
export async function ShowingScheduleWorkflow(
  input: ShowingScheduleWorkflowInput
): Promise<ShowingScheduleWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  if (!input.startTime) {
    throw ApplicationFailure.nonRetryable('startTime is required', 'InvalidArgumentError');
  }
  return bookShowingActivity({
    orgId,
    listingId: input.listingId,
    inquiryId: input.inquiryId,
    startTime: input.startTime,
    endTime: input.endTime,
    summary: input.summary,
    businessKey: input.idempotencyKey || `showing:${orgId}:${input.startTime}`,
  });
}
