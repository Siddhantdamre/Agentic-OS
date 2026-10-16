import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';
import type * as activities from '../activities/index.js';

export interface StuckWorkDetectorWorkflowInput {
  orgId: string;
  repeat?: boolean;
}

export type StuckWorkDetectorInput = StuckWorkDetectorWorkflowInput;

export interface StuckWorkDetectorResult {
  orgId: string;
  processed: number;
}

const { countDueSweepActivity, runStuckWorkActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/**
 * OE-09: continuously scans for deals/expectations stuck past SLA. Runs
 * runStuckWorkActivity hourly alongside the existing idle-count sweep, then
 * continues-as-new once a day so the workflow never accumulates history.
 */
export async function StuckWorkDetectorWorkflow(
  input: StuckWorkDetectorWorkflowInput,
): Promise<StuckWorkDetectorResult> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  let processed = 0;
  for (let i = 0; i < 24; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return { orgId: input.orgId, processed };
    await countDueSweepActivity({
      orgId: input.orgId,
      kind: 'stuck_work',
      before: new Date().toISOString(),
    });
    const result = await runStuckWorkActivity({
      orgId: input.orgId,
      before: new Date().toISOString(),
    });
    processed += result.processed;
    await sleep('1 hour');
  }
  await continueAsNew<typeof StuckWorkDetectorWorkflow>(input);
  return { orgId: input.orgId, processed };
}
