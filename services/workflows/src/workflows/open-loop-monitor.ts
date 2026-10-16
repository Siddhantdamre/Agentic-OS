import { ApplicationFailure, continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import { orgSweepAllowed } from './sweep-gate.js';

export interface OpenLoopMonitorWorkflowInput { orgId: string; }
export interface OpenLoopMonitorWorkflowResult { orgId: string; }

type DueLoop = { id: string; customer_identifier: string; target_check_at: string };

const acts = proxyActivities<{
  dueLoopsActivity: (input: { orgId: string; before: string }) => Promise<DueLoop[]>;
  acquireLeaseActivity: (input: {
    orgId: string; entityKey: string; employeeRole: string; ttlSeconds: number;
  }) => Promise<{ acquired: boolean }>;
  releaseLeaseActivity: (input: { orgId: string; entityKey: string }) => Promise<void>;
  handleDueLoopActivity: (input: {
    orgId: string; loopId: string; businessKey: string; workflowId?: string;
  }) => Promise<{ handled: boolean; reason: string }>;
}>({ startToCloseTimeout: '2 minutes', retry: { initialInterval: '5s', backoffCoefficient: 2, maximumAttempts: 5 } });

export async function OpenLoopMonitorWorkflow(input: OpenLoopMonitorWorkflowInput): Promise<void> {
  if (!input.orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  const workflowId = `open-loops:${input.orgId}`;
  for (let i = 0; i < 96; i++) {
    if (!(await orgSweepAllowed(input.orgId))) return;
    const due = await acts.dueLoopsActivity({ orgId: input.orgId, before: new Date().toISOString() });
    for (const loop of due) {
      const lease = await acts.acquireLeaseActivity({
        orgId: input.orgId, entityKey: loop.customer_identifier, employeeRole: 'customer', ttlSeconds: 300,
      });
      if (!lease.acquired) continue;
      try {
        await acts.handleDueLoopActivity({
          orgId: input.orgId,
          loopId: loop.id,
          businessKey: `loop:${loop.id}:${loop.target_check_at}`,
          workflowId,
        });
      } finally {
        await acts.releaseLeaseActivity({ orgId: input.orgId, entityKey: loop.customer_identifier });
      }
    }
    await sleep('15 minutes');
  }
  await continueAsNew<typeof OpenLoopMonitorWorkflow>(input);
}
