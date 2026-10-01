import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';
import type * as activities from '../activities/index.js';

export interface RepFollowUpSlaWorkflowInput {
  orgId: string;
  repeat?: boolean;
}

export interface RepFollowUpSlaWorkflowResult {
  orgId: string;
  nudged: number;
  escalated: number;
}

const { runRepFollowUpSlaActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/**
 * OE-04: hourly sentinel for high-value leads a rep has not contacted within
 * the SLA. Runs runRepFollowUpSlaActivity (nudge at 3h, escalate at 5h) once
 * per hour, then continues-as-new daily so history never accumulates.
 */
export async function RepFollowUpSlaWorkflow(
  input: RepFollowUpSlaWorkflowInput,
): Promise<RepFollowUpSlaWorkflowResult> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  let nudged = 0;
  let escalated = 0;
  for (let i = 0; i < 24; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return { orgId: input.orgId, nudged, escalated };
    const result = await runRepFollowUpSlaActivity({ orgId: input.orgId });
    nudged += result.nudged;
    escalated += result.escalated;
    await sleep('1 hour');
  }
  if (input.repeat !== false) {
    await continueAsNew<typeof RepFollowUpSlaWorkflow>(input);
  }
  return { orgId: input.orgId, nudged, escalated };
}
