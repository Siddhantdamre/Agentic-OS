import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';

export interface ReplySorterWorkflowInput {
  orgId: string;
}

const { nowIsoActivity, classifyInboundRepliesActivity } = proxyActivities<{
  nowIsoActivity: () => Promise<string>;
  classifyInboundRepliesActivity: (input: {
    orgId: string;
    businessKey: string;
  }) => Promise<{ scanned: number; classified: Record<string, number> }>;
}>({ startToCloseTimeout: '8 minutes', retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 } });

/**
 * GE-09 Smart Reply Sorter — polls Gmail for replies from tracked growth
 * prospects every 20 minutes, classifies them (Interested / Objection / OOO
 * / Unsubscribe), and updates the CRM stage / alerts the rep accordingly.
 */
export async function ReplySorterWorkflow(input: ReplySorterWorkflowInput): Promise<void> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  for (let i = 0; i < 72; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return;
    const now = await nowIsoActivity();
    await classifyInboundRepliesActivity({
      orgId: input.orgId,
      businessKey: `reply-sorter:${input.orgId}:${now}`,
    });
    await sleep('20 minutes');
  }
  await continueAsNew<typeof ReplySorterWorkflow>(input);
}
