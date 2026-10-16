import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

export const BILLING_SWEEP_WORKFLOW_ID = 'billing-sweep';
export const BILLING_SWEEP_TASK_QUEUE = 'darex-agent-tasks';

function intervalMinutes(): number {
  const n = Number(process.env.DAREX_BILLING_SWEEP_MINUTES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 15;
}

/** Starts the singleton billing sweep at worker boot. Idempotent. */
export async function startBillingSweep(client: Client): Promise<'started' | 'already'> {
  try {
    await client.workflow.start('BillingSweepWorkflow', {
      workflowId: BILLING_SWEEP_WORKFLOW_ID,
      taskQueue: BILLING_SWEEP_TASK_QUEUE,
      args: [{ intervalMinutes: intervalMinutes() }],
      workflowIdReusePolicy: 'ALLOW_DUPLICATE',
    });
    return 'started';
  } catch (err) {
    if (
      err instanceof WorkflowExecutionAlreadyStartedError ||
      (err as { name?: string })?.name === 'WorkflowExecutionAlreadyStartedError'
    ) {
      return 'already';
    }
    throw err;
  }
}
