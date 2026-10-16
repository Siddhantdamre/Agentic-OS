import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';
import type * as activities from '../activities/index.js';

export interface WorkloadBalancerWorkflowInput {
  orgId: string;
  repeat?: boolean;
}

export interface WorkloadBalancerWorkflowResult {
  orgId: string;
  assigned: number;
}

const { balanceWorkloadActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/**
 * OE-05: capacity-aware lead routing. Sweeps every 15 minutes for
 * unassigned leads and routes each to the least-loaded rep, skipping the
 * sweep during the org's quiet hours. Continues-as-new daily.
 */
export async function WorkloadBalancerWorkflow(
  input: WorkloadBalancerWorkflowInput,
): Promise<WorkloadBalancerWorkflowResult> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  let assigned = 0;
  for (let i = 0; i < 96; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return { orgId: input.orgId, assigned };
    const result = await balanceWorkloadActivity({ orgId: input.orgId });
    assigned += result.assigned;
    await sleep('15 minutes');
  }
  if (input.repeat !== false) {
    await continueAsNew<typeof WorkloadBalancerWorkflow>(input);
  }
  return { orgId: input.orgId, assigned };
}
