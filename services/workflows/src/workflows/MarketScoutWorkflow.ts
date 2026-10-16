import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';

export interface MarketScoutWorkflowInput {
  orgId: string;
}

const { nowIsoActivity, runMarketScoutActivity } = proxyActivities<{
  nowIsoActivity: () => Promise<string>;
  runMarketScoutActivity: (input: {
    orgId: string;
    businessKey: string;
  }) => Promise<{ searched: boolean; found: number; inserted: number; dailyCap: number }>;
}>({ startToCloseTimeout: '8 minutes', retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 } });

/**
 * GE-02 Market Scout — daily autonomous background scraper. Searches Apollo
 * for decision-makers matching the org's ICP and inserts new leads into the
 * CRM, capped to a daily lead budget enforced inside the activity. The
 * activity itself is cheap and honest when Apollo/HubSpot are unset.
 */
export async function MarketScoutWorkflow(input: MarketScoutWorkflowInput): Promise<void> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  for (let i = 0; i < 30; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return;
    const now = await nowIsoActivity();
    await runMarketScoutActivity({
      orgId: input.orgId,
      businessKey: `market-scout:${input.orgId}:${now}`,
    });
    await sleep('24 hours');
  }
  await continueAsNew<typeof MarketScoutWorkflow>(input);
}
