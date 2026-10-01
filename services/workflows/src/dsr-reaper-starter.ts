import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

export const DSR_REAPER_WORKFLOW_ID = 'dsr-reaper';

/** Starts the singleton DSR reaper sweep at worker boot. Idempotent. */
export async function startDsrReaper(client: Client): Promise<'started' | 'already'> {
  try {
    await client.workflow.start('DsrReaperWorkflow', {
      workflowId: DSR_REAPER_WORKFLOW_ID,
      taskQueue: 'darex-agent-tasks',
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
