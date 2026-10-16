import { ApplicationFailure, proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export type ShowingReminderKind = '24h' | '2h';

export interface ShowingReminderWorkflowInput {
  orgId: string;
  showingId: string;
  startsAt: string;
  idempotencyKey?: string;
}

export interface ShowingReminderWorkflowResult {
  orgId: string;
  showingId: string;
  sent24h: boolean;
  sent2h: boolean;
  skippedCancelled: boolean;
  message: string;
}

const { sendShowingReminderActivity } = proxyActivities<typeof activities>({
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
 * Durable showing reminders: 24h and 2h before startsAt.
 * Activity re-checks DB status — never sends if the showing was cancelled.
 */
export async function ShowingReminderWorkflow(
  input: ShowingReminderWorkflowInput
): Promise<ShowingReminderWorkflowResult> {
  const orgId = requireOrgId(input.orgId);
  if (!input.showingId) {
    throw ApplicationFailure.nonRetryable('showingId is required', 'InvalidArgumentError');
  }
  if (!input.startsAt) {
    throw ApplicationFailure.nonRetryable('startsAt is required', 'InvalidArgumentError');
  }

  const startMs = new Date(input.startsAt).getTime();
  if (!Number.isFinite(startMs)) {
    throw ApplicationFailure.nonRetryable('startsAt must be ISO-8601', 'InvalidArgumentError');
  }

  let sent24h = false;
  let sent2h = false;
  let skippedCancelled = false;

  const delay24 = startMs - 24 * 60 * 60 * 1000 - Date.now();
  if (delay24 > 0) {
    await sleep(delay24);
  }
  const r24 = await sendShowingReminderActivity({
    orgId,
    showingId: input.showingId,
    kind: '24h',
    businessKey: `${input.idempotencyKey || input.showingId}:24h`,
  });
  if (r24.skippedCancelled) skippedCancelled = true;
  sent24h = r24.sent === true;
  if (r24.skippedCancelled) {
    return {
      orgId,
      showingId: input.showingId,
      sent24h,
      sent2h: false,
      skippedCancelled: true,
      message: r24.message,
    };
  }

  const delay2 = startMs - 2 * 60 * 60 * 1000 - Date.now();
  if (delay2 > 0) {
    await sleep(delay2);
  }
  const r2 = await sendShowingReminderActivity({
    orgId,
    showingId: input.showingId,
    kind: '2h',
    businessKey: `${input.idempotencyKey || input.showingId}:2h`,
  });
  if (r2.skippedCancelled) skippedCancelled = true;
  sent2h = r2.sent === true;

  return {
    orgId,
    showingId: input.showingId,
    sent24h,
    sent2h,
    skippedCancelled,
    message:
      skippedCancelled
        ? 'Showing cancelled — remaining reminders skipped'
        : `Reminders done (24h=${sent24h}, 2h=${sent2h})`,
  };
}
