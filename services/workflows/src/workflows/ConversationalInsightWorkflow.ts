import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';

export interface ConversationalInsightWorkflowInput { orgId: string; }

const acts = proxyActivities<{
  nowIsoActivity: () => Promise<string>;
  clusterConversationalInsightsActivity: (input: { orgId: string; beforeIso: string }) => Promise<{ topics: number }>;
  rollupDecisionLedgerActivity: (input: { orgId: string; beforeIso: string }) => Promise<{ rolled: number }>;
}>({ startToCloseTimeout: '3 minutes', retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 } });

export async function ConversationalInsightWorkflow(input: ConversationalInsightWorkflowInput): Promise<void> {
  if (!input.orgId) throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  for (let i = 0; i < 30; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return;
    const beforeIso = await acts.nowIsoActivity();
    await acts.clusterConversationalInsightsActivity({ orgId: input.orgId, beforeIso });
    await acts.rollupDecisionLedgerActivity({ orgId: input.orgId, beforeIso });
    await sleep('24 hours');
  }
  await continueAsNew<typeof ConversationalInsightWorkflow>(input);
}
