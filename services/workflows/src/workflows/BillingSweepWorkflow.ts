import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export interface BillingSweepWorkflowInput {
  /** Minutes between passes. Default 15. */
  intervalMinutes?: number;
}

const { refreshAllOrgMetersActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '30 seconds' },
});

/** Passes per run before continue-as-new, so history stays small. */
const PASSES_PER_RUN = 48;

/**
 * BIZ-B01: one platform-wide sweep (workflow id `billing-sweep`) that keeps
 * billing_meters current for every org, so hard caps trip without anyone
 * opening /billing.
 */
export async function BillingSweepWorkflow(input: BillingSweepWorkflowInput = {}): Promise<void> {
  const minutes = Math.max(1, Math.floor(input.intervalMinutes ?? 15));
  for (let i = 0; i < PASSES_PER_RUN; i++) {
    await refreshAllOrgMetersActivity();
    await sleep(`${minutes} minutes`);
  }
  await continueAsNew<typeof BillingSweepWorkflow>(input);
}
