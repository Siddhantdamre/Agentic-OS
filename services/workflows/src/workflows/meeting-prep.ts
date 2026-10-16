import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';
import type { CalendarDeadlockAuditResult, MeetingPrepAuditResult } from '../operations/meeting-prep.js';

export interface MeetingPrepWorkflowInput {
  orgId: string;
  intervalHours?: number;
  repeat?: boolean;
}

export interface MeetingPrepWorkflowResult {
  orgId: string;
  result: MeetingPrepAuditResult;
  calendarDeadlocks: CalendarDeadlockAuditResult;
}

const { auditMeetingPrepActivity, auditCalendarDeadlocksActivity } = proxyActivities<{
  auditMeetingPrepActivity: (params: { orgId: string }) => Promise<MeetingPrepAuditResult>;
  auditCalendarDeadlocksActivity: (params: { orgId: string }) => Promise<CalendarDeadlockAuditResult>;
}>({
  startToCloseTimeout: '5 minutes',
  retry: {
    initialInterval: '5s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['InvalidArgumentError'],
  },
});

/**
 * Nightly Meeting Preparation Readiness Workflow (03 §8, Blueprint pp. 81-82).
 * Scans upcoming meetings for tomorrow, identifies missing briefs, and generates them.
 *
 * Also runs the OE-08 Calendar Deadlock Fixer on the same cadence: injects
 * missing Google Meet links, flags double-booked meetings to Slack, and
 * pings unconfirmed guests by email.
 */
export async function MeetingPrepWorkflow(
  input: MeetingPrepWorkflowInput
): Promise<MeetingPrepWorkflowResult> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }

  if (!(await orgSweepAllowed(input.orgId))) {
    return { orgId: input.orgId, result: null, calendarDeadlocks: null } as unknown as MeetingPrepWorkflowResult;
  }
  const result = await auditMeetingPrepActivity({ orgId: input.orgId });
  const calendarDeadlocks = await auditCalendarDeadlocksActivity({ orgId: input.orgId });

  if (input.repeat !== false) {
    const hours = input.intervalHours ?? 24;
    await sleep(hours * 3600_000);
    await continueAsNew<typeof MeetingPrepWorkflow>({
      orgId: input.orgId,
      intervalHours: hours,
      repeat: true,
    });
  }

  return { orgId: input.orgId, result, calendarDeadlocks };
}
