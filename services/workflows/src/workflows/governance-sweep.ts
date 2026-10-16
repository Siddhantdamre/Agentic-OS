import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type * as governance from '../activities/sweep-governance.js';
import { orgSweepAllowed } from './sweep-gate.js';

export interface GovernanceSweepWorkflowInput {
  orgId: string;
}

const { expirePendingDecisionsActivity, breachWorkItemSlaActivity } = proxyActivities<typeof governance>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '10 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/**
 * OPS-G01: decision expiry and work-item SLA breach, every 15 minutes per
 * org. Before this, both only ran when an admin POSTed /api/decisions/sweep
 * or /api/work-items/sweep-sla, and nothing ever called either route.
 */
export async function GovernanceSweepWorkflow(input: GovernanceSweepWorkflowInput): Promise<void> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  for (let i = 0; i < 96; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return;
    await expirePendingDecisionsActivity({ orgId: input.orgId });
    await breachWorkItemSlaActivity({ orgId: input.orgId });
    await sleep('15 minutes');
  }
  await continueAsNew<typeof GovernanceSweepWorkflow>(input);
}
