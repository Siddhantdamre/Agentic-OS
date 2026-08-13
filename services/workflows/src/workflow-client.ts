import { Connection, Client } from '@temporalio/client';
import { AgentTaskInput, AgentTaskResult } from './agent-engine.js';
import type { CrewWorkflowInput, CrewWorkflowResult } from '@darex/shared-types';

let clientInstance: Client | null = null;
let connecting: Promise<Client | null> | null = null;

export async function getTemporalClient(): Promise<Client | null> {
  if (clientInstance) return clientInstance;
  if (connecting) return connecting;

  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  connecting = (async () => {
    try {
      const connection = await Promise.race([
        Connection.connect({ address }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Temporal connect timed out after 5s (${address})`)), 5000)
        ),
      ]);
      clientInstance = new Client({ connection });
      console.log(`Connected to Temporal cluster at ${address}`);
      return clientInstance;
    } catch (err: any) {
      console.warn(`[Temporal Client] Could not connect to cluster at ${address}: ${err.message}`);
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

function workflowIdFor(input: AgentTaskInput): string {
  const stamp = Date.now();
  if (input.idempotencyKey) return `agent-task-${input.orgId}-${input.idempotencyKey}`;
  if (input.conversationId) return `agent-task-${input.orgId}-${input.conversationId}-${stamp}`;
  return `agent-task-${input.orgId}-${stamp}`;
}

export async function triggerAutonomousAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult | null> {
  const client = await getTemporalClient();
  if (!client) return null;

  const workflowId = workflowIdFor(input);
  try {
    const handle = await client.workflow.start('AutonomousAgentWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
      workflowExecutionTimeout: '25 minutes',
    });
    console.log(`Temporal AutonomousAgentWorkflow started: ${handle.workflowId}`);
    return await handle.result();
  } catch (err: any) {
    console.error(`[Temporal Execution Error] Workflow ${workflowId} failed:`, err.message);
    return null;
  }
}

export async function startAutonomousAgentWorkflow(input: AgentTaskInput) {
  const client = await getTemporalClient();
  if (!client) return null;

  const workflowId = workflowIdFor(input);
  try {
    const handle = await client.workflow.start('AutonomousAgentWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
      workflowExecutionTimeout: '25 minutes',
    });
    console.log(`Temporal AutonomousAgentWorkflow started: ${handle.workflowId}`);
    return handle;
  } catch (err: any) {
    console.error(`[Temporal Start Error] Workflow ${workflowId} start failed:`, err.message);
    return null;
  }
}

function crewWorkflowIdFor(input: CrewWorkflowInput): string {
  const stamp = Date.now();
  if (input.idempotencyKey) return `crew-task-${input.orgId}-${input.idempotencyKey}`;
  if (input.conversationId) return `crew-task-${input.orgId}-${input.conversationId}-${stamp}`;
  return `crew-task-${input.orgId}-${stamp}`;
}

export async function triggerCrewWorkflow(input: CrewWorkflowInput): Promise<CrewWorkflowResult | null> {
  const client = await getTemporalClient();
  if (!client) return null;

  const workflowId = crewWorkflowIdFor(input);
  try {
    const handle = await client.workflow.start('CrewWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
      workflowExecutionTimeout: '40 minutes',
    });
    console.log(`Temporal CrewWorkflow started: ${handle.workflowId}`);
    return await handle.result();
  } catch (err: any) {
    console.error(`[Temporal Execution Error] CrewWorkflow ${workflowId} failed:`, err.message);
    return null;
  }
}

export async function startCrewWorkflow(input: CrewWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;

  const workflowId = crewWorkflowIdFor(input);
  try {
    const handle = await client.workflow.start('CrewWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
      workflowExecutionTimeout: '40 minutes',
    });
    console.log(`Temporal CrewWorkflow started: ${handle.workflowId}`);
    return handle;
  } catch (err: any) {
    console.error(`[Temporal Start Error] CrewWorkflow ${workflowId} start failed:`, err.message);
    return null;
  }
}
