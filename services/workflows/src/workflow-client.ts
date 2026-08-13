import { Connection, Client } from '@temporalio/client';
import { AgentTaskInput, AgentTaskResult } from './agent-engine.js';
import type { CrewWorkflowInput, CrewWorkflowResult } from '@darex/shared-types';
import type { WorkItemWorkflowInput } from './workflows/WorkItemWorkflow.js';
import type { PlanConfirmDecision, PlanExecuteWorkflowInput } from './workflows/PlanExecuteWorkflow.js';
import type { OwnerBriefingWorkflowInput } from './workflows/OwnerBriefingWorkflow.js';
import type { StaleChaseWorkflowInput } from './workflows/StaleChaseWorkflow.js';
import type { NurtureWorkflowInput } from './workflows/NurtureWorkflow.js';
import type { InsightActionWorkflowInput } from './workflows/InsightActionWorkflow.js';
import type { ShowingScheduleWorkflowInput } from './workflows/ShowingScheduleWorkflow.js';
import type { RentReminderWorkflowInput } from './workflows/RentReminderWorkflow.js';
import type { NurtureCancelReason } from './quiet-hours.js';
import {
  insightActionWorkflowId,
  nurtureWorkflowId,
  ownerBriefingWorkflowId,
  planExecuteWorkflowId,
  staleChaseWorkflowId,
} from './quiet-hours.js';

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

function workItemWorkflowIdFor(input: WorkItemWorkflowInput): string {
  if (input.idempotencyKey) return `work-item-${input.orgId}-${input.idempotencyKey}`;
  if (input.inboundEventId) return `work-item-${input.orgId}-${input.inboundEventId}`;
  return `work-item-${input.orgId}-${input.conversationId}-${Date.now()}`;
}

function isAlreadyStarted(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { name?: string; message?: string };
  if (rec.name === 'WorkflowExecutionAlreadyStartedError') return true;
  return /already (started|running)/i.test(String(rec.message || ''));
}

export async function startWorkItemWorkflow(input: WorkItemWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;

  const workflowId = workItemWorkflowIdFor(input);
  const args = [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }];
  try {
    const handle = await client.workflow.start('WorkItemWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args,
      // O7 HITL wait can outlive a 25-minute agent turn.
      workflowExecutionTimeout: '7 days',
    });
    console.log(`Temporal WorkItemWorkflow started: ${handle.workflowId}`);
    return handle;
  } catch (err: any) {
    if (isAlreadyStarted(err)) {
      console.log(`Temporal WorkItemWorkflow already started: ${workflowId}`);
      return client.workflow.getHandle(workflowId);
    }
    console.error(`[Temporal Start Error] WorkItemWorkflow ${workflowId} start failed:`, err.message);
    return null;
  }
}

function memoryWriteBackWorkflowIdFor(input: {
  orgId: string;
  conversationId: string;
  businessKey?: string;
}): string {
  if (input.businessKey) return `memory-writeback-${input.orgId}-${input.businessKey}`;
  return `memory-writeback-${input.orgId}-${input.conversationId}-${Date.now()}`;
}

/**
 * Fire-and-forget MemoryWriteBackWorkflow. Must not be awaited for completion
 * on a webhook or Ask AI stream thread.
 */
export async function startMemoryWriteBackWorkflow(input: {
  orgId: string;
  conversationId: string;
  workItemId?: string;
  closed?: boolean;
  toolResults?: unknown;
  transcriptExcerpt?: string;
  businessKey?: string;
}): Promise<void> {
  const client = await getTemporalClient();
  if (!client) return;
  const workflowId = memoryWriteBackWorkflowIdFor(input);
  try {
    await client.workflow.start('MemoryWriteBackWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [
        {
          orgId: input.orgId,
          conversationId: input.conversationId,
          workItemId: input.workItemId,
          closed: input.closed === true,
          toolResults: input.toolResults,
          transcriptExcerpt: input.transcriptExcerpt,
          businessKey: input.businessKey || workflowId,
        },
      ],
      workflowExecutionTimeout: '10 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[memory-writeback] start failed for ${workflowId}: ${message}`);
  }
}

export async function startPlanExecuteWorkflow(input: PlanExecuteWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = planExecuteWorkflowId(input.orgId, input.planId);
  try {
    const handle = await client.workflow.start('PlanExecuteWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
      workflowExecutionTimeout: '40 minutes',
    });
    return handle;
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] PlanExecuteWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}

export async function getPlanExecuteHandle(orgId: string, planId: string) {
  const client = await getTemporalClient();
  if (!client) return null;
  return client.workflow.getHandle(planExecuteWorkflowId(orgId, planId));
}

/**
 * O7: PlanCard approve/reject signals waiting PlanExecute + WorkItem workflows.
 * Never takes orgId from the request body — callers pass session orgId.
 */
export async function signalPlanDecision(params: {
  orgId: string;
  planId: string;
  decision: PlanConfirmDecision;
  workItemWorkflowIds?: string[];
}): Promise<void> {
  const client = await getTemporalClient();
  if (!client) return;
  const planWf = planExecuteWorkflowId(params.orgId, params.planId);
  const ids = [planWf, ...(params.workItemWorkflowIds || [])].filter(Boolean);
  for (const workflowId of ids) {
    try {
      const handle = client.workflow.getHandle(workflowId);
      if (params.decision === 'rejected') {
        if (workflowId === planWf) await handle.signal('rejectPlan');
        else await handle.signal('rejectWorkItem');
      } else if (params.decision === 'approved') {
        if (workflowId === planWf) await handle.signal('approvePlan', 'approved');
        else await handle.signal('approveWorkItem', 'approved');
      } else {
        const _exhaustive: never = params.decision;
        void _exhaustive;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found|not running|no running/i.test(message)) continue;
      console.warn(`[HITL signal] ${workflowId}: ${message}`);
    }
  }
}

export async function startOwnerBriefingWorkflow(input: OwnerBriefingWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = ownerBriefingWorkflowId(input.orgId);
  try {
    return await client.workflow.start('OwnerBriefingWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [input],
      workflowExecutionTimeout: '400 days',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] OwnerBriefingWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}

export async function startStaleChaseWorkflow(input: StaleChaseWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = staleChaseWorkflowId(input.orgId, input.idempotencyKey);
  try {
    return await client.workflow.start('StaleChaseWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [input],
      workflowExecutionTimeout: '30 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] StaleChaseWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}

export async function startNurtureWorkflow(input: NurtureWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = nurtureWorkflowId(input.orgId, input.conversationId);
  try {
    return await client.workflow.start('NurtureWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [input],
      workflowExecutionTimeout: '14 days',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] NurtureWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}

/** Cancel nurture on inbound reply or human takeover. Fire-and-forget. */
export async function signalNurtureCancelled(params: {
  orgId: string;
  conversationId: string;
  reason: NurtureCancelReason;
}): Promise<void> {
  const client = await getTemporalClient();
  if (!client) return;
  const workflowId = nurtureWorkflowId(params.orgId, params.conversationId);
  try {
    await client.workflow.getHandle(workflowId).signal('cancelNurture', params.reason);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|not running|no running/i.test(message)) return;
    console.warn(`[nurture cancel] ${workflowId}: ${message}`);
  }
}

export async function startInsightActionWorkflow(input: InsightActionWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = insightActionWorkflowId(
    input.orgId,
    input.metricId,
    input.idempotencyKey
  );
  try {
    return await client.workflow.start('InsightActionWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
      workflowExecutionTimeout: '40 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] InsightActionWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}

function showingWorkflowId(input: ShowingScheduleWorkflowInput): string {
  if (input.idempotencyKey) return `showing-${input.orgId}-${input.idempotencyKey}`;
  const slot = String(input.startTime || '').replace(/[^0-9T]/g, '');
  const target = input.listingId || input.inquiryId || 'open';
  return `showing-${input.orgId}-${target}-${slot}`;
}

function rentReminderWorkflowId(input: RentReminderWorkflowInput): string {
  if (input.idempotencyKey) return `rent-${input.orgId}-${input.idempotencyKey}`;
  return `rent-${input.orgId}-${input.chargeId}`;
}

/** Book a showing via ShowingScheduleWorkflow. Null if Temporal is down. */
export async function startShowingScheduleWorkflow(input: ShowingScheduleWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = showingWorkflowId(input);
  try {
    return await client.workflow.start('ShowingScheduleWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
      workflowExecutionTimeout: '8 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] ShowingScheduleWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}

/** Rent reminder via RentReminderWorkflow. Null if Temporal is down. */
export async function startRentReminderWorkflow(input: RentReminderWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = rentReminderWorkflowId(input);
  try {
    return await client.workflow.start('RentReminderWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
      workflowExecutionTimeout: '8 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] RentReminderWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}
