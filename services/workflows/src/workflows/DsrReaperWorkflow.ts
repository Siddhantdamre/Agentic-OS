import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

const { reapStaleDsrActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '30 seconds' },
});

/** 15-minute passes, 96 per run (a day), then continue-as-new so history stays small. */
const PASSES_PER_RUN = 96;

/** One platform-wide sweep that fails DSR delete jobs stuck in `running` (workflow id `dsr-reaper`). */
export async function DsrReaperWorkflow(): Promise<void> {
  for (let i = 0; i < PASSES_PER_RUN; i++) {
    await reapStaleDsrActivity();
    await sleep('15 minutes');
  }
  await continueAsNew<typeof DsrReaperWorkflow>();
}
