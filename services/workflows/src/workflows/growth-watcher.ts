import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';

export interface GrowthWatcherWorkflowInput {
  orgId: string;
}

const { nowIsoActivity, runGrowthWatchActivity } = proxyActivities<{
  nowIsoActivity: () => Promise<string>;
  runGrowthWatchActivity: (input: {
    orgId: string;
    businessKey: string;
  }) => Promise<{ idle: boolean; signals: number; opportunities: number }>;
}>({ startToCloseTimeout: '8 minutes', retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 } });

/**
 * 4-hour growth signal sweep. Always runs the lookalike/signal activity —
 * the activity itself is cheap when HubSpot/Jina are unset (honest empty).
 * Wall clock comes from nowIsoActivity; workflows must not call Date().
 */
export async function GrowthWatcherWorkflow(input: GrowthWatcherWorkflowInput): Promise<void> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  for (let i = 0; i < 42; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return;
    const now = await nowIsoActivity();
    await runGrowthWatchActivity({
      orgId: input.orgId,
      businessKey: `growth-watch:${input.orgId}:${now}`,
    });
    await sleep('4 hours');
  }
  await continueAsNew<typeof GrowthWatcherWorkflow>(input);
}
