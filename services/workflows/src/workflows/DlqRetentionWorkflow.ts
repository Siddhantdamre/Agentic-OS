import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

const { purgeFailedWebhooksActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '30 seconds' },
});

/** Daily passes before continue-as-new, so history stays small. */
const PASSES_PER_RUN = 30;

/** Webhooks #15: one platform-wide daily purge (workflow id `dlq-retention`). */
export async function DlqRetentionWorkflow(): Promise<void> {
  for (let i = 0; i < PASSES_PER_RUN; i++) {
    await purgeFailedWebhooksActivity();
    await sleep('24 hours');
  }
  await continueAsNew<typeof DlqRetentionWorkflow>();
}
