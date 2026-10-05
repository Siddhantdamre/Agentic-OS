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
import type { ShowingReminderWorkflowInput } from './workflows/ShowingReminderWorkflow.js';
import type { RentReminderWorkflowInput } from './workflows/RentReminderWorkflow.js';
import type { NurtureCancelReason } from './quiet-hours.js';
import {
  insightActionWorkflowId,
  nurtureWorkflowId,
  ownerBriefingWorkflowId,
  planExecuteWorkflowId,
  staleChaseWorkflowId,
} from './quiet-hours.js';
import { withOrgClient } from './db.js';
import { markDsrRequestFailed, runDsrDelete } from './dsr/run-delete.js';
import { runDsrExport } from './dsr/run-export.js';
import { createLazyConnector } from './temporal-connect.js';

function envMs(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const temporalAddress = () => process.env.TEMPORAL_ADDRESS || 'localhost:7233';

// One shared attempt, cached on success; after a failure the next TEMPORAL_RETRY_BACKOFF_MS (default 10 s)
// answer null at once, so a Temporal outage costs one request the connect timeout instead of every request.
const getClient = createLazyConnector<Client>({
  connect: async () => new Client({ connection: await Connection.connect({ address: temporalAddress() }) }),
  timeoutMs: envMs('TEMPORAL_CONNECT_TIMEOUT_MS', 5000),
  backoffMs: envMs('TEMPORAL_RETRY_BACKOFF_MS', 10_000),
  onConnected: () => console.log(`Connected to Temporal cluster at ${temporalAddress()}`),
  onFailure: (err) => console.warn(`[Temporal Client] Could not connect to cluster at ${temporalAddress()}: ${err.message}`),
});

export async function getTemporalClient(): Promise<Client | null> {
  return getClient();
}

function workflowIdFor(input: AgentTaskInput): string {
  const stamp = Date.now();
  if (input.idempotencyKey) return `agent-task-${input.orgId}-${input.idempotencyKey}`;
  if (input.conversationId) return `agent-task-${input.orgId}-${input.conversationId}-${stamp}`;
  return `agent-task-${input.orgId}-${stamp}`;
}

/**
 * Returns null ONLY when Temporal is unreachable (caller may use direct
 * fallback). Throws when the workflow starts but fails — callers must NOT
 * silently re-run direct in that case (tools may already have executed).
 */
export async function triggerAutonomousAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult | null> {
  const client = await getTemporalClient();
  if (!client) return null;

  const workflowId = workflowIdFor(input);
  const handle = await client.workflow.start('AutonomousAgentWorkflow', {
    taskQueue: 'darex-agent-tasks',
    workflowId,
    args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
    workflowExecutionTimeout: '25 minutes',
  }).catch((err: any) => {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    throw err;
  });
  console.log(`Temporal AutonomousAgentWorkflow started: ${handle.workflowId}`);
  return await handle.result();
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
    if (isAlreadyStarted(err)) {
      console.log(`Temporal AutonomousAgentWorkflow already started: ${workflowId}`);
      return client.workflow.getHandle(workflowId);
    }
    throw err;
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
  const handle = await client.workflow.start('CrewWorkflow', {
    taskQueue: 'darex-agent-tasks',
    workflowId,
    args: [{ ...input, idempotencyKey: input.idempotencyKey || workflowId }],
    workflowExecutionTimeout: '40 minutes',
  }).catch((err: any) => {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    throw err;
  });
  console.log(`Temporal CrewWorkflow started: ${handle.workflowId}`);
  return await handle.result();
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
    if (isAlreadyStarted(err)) {
      console.log(`Temporal CrewWorkflow already started: ${workflowId}`);
      return client.workflow.getHandle(workflowId);
    }
    throw err;
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
/**
 * Slack / dashboard HITL: signal a running WorkItemWorkflow.
 * Callers pass the Temporal workflow id already stored on the work item —
 * never an orgId from the request body.
 */
export async function signalWorkItemDecision(params: {
  workflowId: string;
  decision: 'approved' | 'rejected';
  optionId?: string;
}): Promise<void> {
  const client = await getTemporalClient();
  if (!client || !params.workflowId) return;
  try {
    const handle = client.workflow.getHandle(params.workflowId);
    if (params.decision === 'rejected') {
      await handle.signal('rejectWorkItem');
      return;
    }
    if (params.decision === 'approved') {
      await handle.signal('approveWorkItem', params.optionId || 'approved');
      return;
    }
    const _exhaustive: never = params.decision;
    void _exhaustive;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|not running|no running/i.test(message)) return;
    console.warn(`[HITL signal] ${params.workflowId}: ${message}`);
  }
}

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

function showingReminderWorkflowId(input: ShowingReminderWorkflowInput): string {
  if (input.idempotencyKey) return `showing-reminder-${input.orgId}-${input.idempotencyKey}`;
  return `showing-reminder-${input.orgId}-${input.showingId}`;
}

/** Schedule 24h/2h showing reminders. Null if Temporal is down. */
export async function startShowingReminderWorkflow(input: ShowingReminderWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = showingReminderWorkflowId(input);
  try {
    return await client.workflow.start('ShowingReminderWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [{ ...input, idempotencyKey: input.idempotencyKey || input.showingId }],
      // Showings may be booked weeks ahead; durable sleep until start.
      workflowExecutionTimeout: '60 days',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] ShowingReminderWorkflow ${workflowId} start failed:`, message);
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

export type DsrJobWorkflowInput = {
  orgId: string;
  dsrRequestId: string;
  requestedByUserId: string | null;
};

function dsrDeleteWorkflowId(orgId: string, dsrRequestId: string): string {
  return `dsr-delete-${orgId}-${dsrRequestId}`;
}

function dsrExportWorkflowId(orgId: string, dsrRequestId: string): string {
  return `dsr-export-${orgId}-${dsrRequestId}`;
}

/**
 * Fire-and-forget GDPR delete. Caller must release the DB client first.
 * Returns null when Temporal is unreachable (caller may run direct fallback).
 */
export async function startDsrDeleteWorkflow(input: DsrJobWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = dsrDeleteWorkflowId(input.orgId, input.dsrRequestId);
  try {
    return await client.workflow.start('DsrDeleteWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [input],
      workflowExecutionTimeout: '60 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] DsrDeleteWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}

/**
 * Fire-and-forget GDPR export. Caller must release the DB client first.
 * Returns null when Temporal is unreachable (caller may run direct fallback).
 */
export async function startDsrExportWorkflow(input: DsrJobWorkflowInput) {
  const client = await getTemporalClient();
  if (!client) return null;
  const workflowId = dsrExportWorkflowId(input.orgId, input.dsrRequestId);
  try {
    return await client.workflow.start('DsrExportWorkflow', {
      taskQueue: 'darex-agent-tasks',
      workflowId,
      args: [input],
      workflowExecutionTimeout: '60 minutes',
    });
  } catch (err: unknown) {
    if (isAlreadyStarted(err)) return client.workflow.getHandle(workflowId);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Temporal Start Error] DsrExportWorkflow ${workflowId} start failed:`, message);
    return null;
  }
}

/**
 * Start Temporal delete, or run the resumable delete in-process when Temporal
 * is down so the row never sits in pending/running with no worker.
 * Must be called after the HTTP handler has released its pooled client.
 */
export async function enqueueDsrDelete(input: DsrJobWorkflowInput): Promise<'temporal' | 'direct'> {
  const handle = await startDsrDeleteWorkflow(input);
  if (handle) return 'temporal';
  void withOrgClient(input.orgId, (db) =>
    runDsrDelete(db, {
      orgId: input.orgId,
      dsrRequestId: input.dsrRequestId,
      requestedByUserId: input.requestedByUserId,
    })
  ).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dsr] direct delete failed for ${input.dsrRequestId}:`, message);
    try {
      await withOrgClient(input.orgId, (db) =>
        markDsrRequestFailed(db, {
          orgId: input.orgId,
          dsrRequestId: input.dsrRequestId,
          error: message,
        })
      );
    } catch (markErr: unknown) {
      console.error('[dsr] mark failed after direct delete error:', markErr);
    }
  });
  return 'direct';
}

/**
 * Start Temporal export, or write the artifact in-process when Temporal is down.
 * Must be called after the HTTP handler has released its pooled client.
 */
export async function enqueueDsrExport(input: DsrJobWorkflowInput): Promise<'temporal' | 'direct'> {
  const handle = await startDsrExportWorkflow(input);
  if (handle) return 'temporal';
  void withOrgClient(input.orgId, (db) =>
    runDsrExport(db, {
      orgId: input.orgId,
      dsrRequestId: input.dsrRequestId,
      requestedByUserId: input.requestedByUserId,
    })
  ).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dsr] direct export failed for ${input.dsrRequestId}:`, message);
    try {
      await withOrgClient(input.orgId, (db) =>
        markDsrRequestFailed(db, {
          orgId: input.orgId,
          dsrRequestId: input.dsrRequestId,
          error: message,
        })
      );
    } catch (markErr: unknown) {
      console.error('[dsr] mark failed after direct export error:', markErr);
    }
  });
  return 'direct';
}
