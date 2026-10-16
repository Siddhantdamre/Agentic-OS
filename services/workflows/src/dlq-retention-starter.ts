import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

export const DLQ_RETENTION_WORKFLOW_ID = 'dlq-retention';

/** Starts the singleton DLQ retention sweep at worker boot. Idempotent. */
export async function startDlqRetention(client: Client): Promise<'started' | 'already'> {
  try {
    await client.workflow.start('DlqRetentionWorkflow', {
      workflowId: DLQ_RETENTION_WORKFLOW_ID,
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
