import { Connection, Client } from '@temporalio/client';
import { AgentTaskInput, AgentTaskResult } from './agent-engine.js';

let clientInstance: Client | null = null;

export async function getTemporalClient(): Promise<Client | null> {
  if (clientInstance) return clientInstance;

  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  try {
    const connection = await Connection.connect({ address });
    clientInstance = new Client({ connection });
    console.log(`✓ Connected to Temporal cluster at ${address}`);
    return clientInstance;
  } catch (err: any) {
    console.warn(`[Temporal Client] Could not connect to cluster at ${address}: ${err.message}`);
    return null;
  }
}

export async function triggerAutonomousAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult | null> {
  const client = await getTemporalClient();
  if (!client) return null;

  const workflowId = `agent-task-${input.orgId}-${Date.now()}`;
  try {
    const handle = await client.workflow.start('AutonomousAgentWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [input],
    });
    console.log(`🚀 Temporal AutonomousAgentWorkflow started: ${handle.workflowId}`);
    return await handle.result();
  } catch (err: any) {
    console.error(`[Temporal Execution Error] Workflow ${workflowId} failed:`, err.message);
    return null;
  }
}

export async function startAutonomousAgentWorkflow(input: AgentTaskInput) {
  const client = await getTemporalClient();
  if (!client) return null;

  const workflowId = `agent-task-${input.orgId}-${Date.now()}`;
  try {
    const handle = await client.workflow.start('AutonomousAgentWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [input],
    });
    console.log(`🚀 Temporal AutonomousAgentWorkflow started: ${handle.workflowId}`);
    return handle;
  } catch (err: any) {
    console.error(`[Temporal Start Error] Workflow ${workflowId} start failed:`, err.message);
    return null;
  }
}
