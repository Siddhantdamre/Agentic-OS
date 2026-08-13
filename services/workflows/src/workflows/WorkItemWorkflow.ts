import {
  proxyActivities,
  executeChild,
  startChild,
  ParentClosePolicy,
  defineSignal,
  setHandler,
  workflowInfo,
  condition,
} from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { AgentTaskInput, AgentTaskResult } from '../agent-engine.js';
import { AutonomousAgentWorkflow } from './AutonomousAgentWorkflow.js';
import { MemoryWriteBackWorkflow } from './MemoryWriteBackWorkflow.js';
import { isHumanDestination } from '../route-employee.js';
import { resolveInboundHitlGate } from '../inbound-hitl.js';

// Local types (WS-10 owns packages/shared-types — do not add work-item types there).
export type WorkItemChannel = 'whatsapp' | 'chatwoot' | 'inbox' | 'ask_ai' | 'unknown';
export type WorkItemStatus =
  | 'open'
  | 'in_progress'
  | 'waiting_approval'
  | 'needs_attention'
  | 'done'
  | 'cancelled';
export type WorkItemType = 'conversation';

export type WorkEventKind =
  | 'inbound_received'
  | 'memory_retrieved'
  | 'employee_routed'
  | 'agent_started'
  | 'agent_replied'
  | 'agent_failed'
  | 'needs_attention'
  | 'memory_writeback'
  | 'embed_enqueued'
  | 'confirm_requested'
  | 'confirm_approved'
  | 'confirm_rejected'
  | 'critic_blocked';

export interface WorkItemWorkflowInput {
  orgId: string;
  channel: WorkItemChannel;
  conversationId: string;
  status?: WorkItemStatus;
  inboundEventId?: string;
  channelId?: string;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  connectedChannels?: string[];
  userMessage: string;
  idempotencyKey?: string;
}

export interface WorkItemWorkflowResult {
  workItemId: string;
  status: WorkItemStatus;
  replyMessage?: string;
  executedSteps?: unknown[];
  savedByWorkflow: boolean;
  success: boolean;
  error?: string;
  hitlDecision?: WorkItemConfirmDecision;
}

export type WorkItemConfirmDecision = 'approved' | 'rejected';

/** O7: PlanCard / owner-WhatsApp approve/reject signals this; inbound send/pay/sign waits before tools. */
export const approveWorkItemSignal = defineSignal<[WorkItemConfirmDecision?]>('approveWorkItem');
export const rejectWorkItemSignal = defineSignal('rejectWorkItem');

const {
  upsertWorkItemActivity,
  updateWorkItemStatusActivity,
  appendWorkEventActivity,
  retrieveMemoryActivity,
  routeEmployeeActivity,
  criticCheck,
  enqueueEmbedActivity,
  markNeedsAttentionActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  scheduleToCloseTimeout: '6 minutes',
  retry: {
    initialInterval: '2s',
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['AuthorizationError', 'InvalidArgumentError'],
  },
});

function sessionKeyForWorkItem(workItemId: string): string {
  return workItemId;
}

function nextStatus(event: 'start' | 'done' | 'fail' | 'await_confirm' | 'cancel'): WorkItemStatus {
  switch (event) {
    case 'start':
      return 'in_progress';
    case 'done':
      return 'done';
    case 'fail':
      return 'needs_attention';
    case 'await_confirm':
      return 'waiting_approval';
    case 'cancel':
      return 'cancelled';
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function eventKindForConfirm(decision: WorkItemConfirmDecision): WorkEventKind {
  switch (decision) {
    case 'approved':
      return 'confirm_approved';
    case 'rejected':
      return 'confirm_rejected';
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

/**
 * Q1 wrap: inbound WorkItemWorkflow around AutonomousAgentWorkflow.
 * Does not replace the child. Does not auto-spawn CrewWorkflow.
 * Session for the child turn: darex:{orgId}:{workItemId} via sessionKey=workItemId.
 */
export async function WorkItemWorkflow(input: WorkItemWorkflowInput): Promise<WorkItemWorkflowResult> {
  const parentId = workflowInfo().workflowId;
  const businessKey = input.idempotencyKey || input.inboundEventId || parentId;
  let lastConfirm: WorkItemConfirmDecision | undefined;

  setHandler(approveWorkItemSignal, (decision) => {
    lastConfirm = decision === 'rejected' ? 'rejected' : 'approved';
  });
  setHandler(rejectWorkItemSignal, () => {
    lastConfirm = 'rejected';
  });

  const upserted = await upsertWorkItemActivity({
    orgId: input.orgId,
    conversationId: input.conversationId,
    channel: input.channel,
    type: 'conversation',
    status: nextStatus('start'),
    assigneeEmployeeId: input.employeeId,
    temporalWorkflowId: parentId,
    inboundEventId: input.inboundEventId,
    businessKey,
  });

  const workItemId = upserted.workItemId;

  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'inbound_received',
    actor: 'webhook',
    payload: {
      conversationId: input.conversationId,
      channel: input.channel,
      inboundEventId: input.inboundEventId,
    },
    businessKey: `${businessKey}:inbound_received`,
  });

  const memory = await retrieveMemoryActivity({
    orgId: input.orgId,
    workItemId,
    conversationId: input.conversationId,
    query: input.userMessage,
    employeeId: input.employeeId,
    businessKey: `${businessKey}:retrieveMemory`,
  });
  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'memory_retrieved',
    actor: 'system',
    payload: { factCount: memory.facts.length, noOp: memory.noOp },
    businessKey: `${businessKey}:memory_retrieved`,
  });

  // E2: route(work_item). Emergency → human/dispatch, not ISA. Name lock from "Ask Marcus to".
  const routed = await routeEmployeeActivity({
    orgId: input.orgId,
    workItemId,
    employeeId: input.employeeId,
    employeeName: input.employeeName,
    employeeRole: input.employeeRole,
    employeePersona: input.employeePersona,
    toolAllowlist: input.toolAllowlist,
    userMessage: input.userMessage,
    channel: input.channel,
    businessKey: `${businessKey}:routeEmployee`,
  });
  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'employee_routed',
    actor: 'system',
    payload: {
      employeeId: routed.employeeId,
      employeeName: routed.employeeName,
      passthrough: routed.passthrough,
      destination: routed.destination,
      confidence: routed.confidence,
      reason: routed.reason,
      locked: routed.locked,
    },
    businessKey: `${businessKey}:employee_routed`,
  });

  if (isHumanDestination(routed.destination || 'employee')) {
    await markNeedsAttentionActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      reason: routed.reason || 'human_dispatch',
      businessKey: `${businessKey}:needs_attention`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'needs_attention',
      actor: 'system',
      payload: { reason: routed.reason, destination: routed.destination },
      businessKey: `${businessKey}:needs_attention_event`,
    });
    return {
      workItemId,
      status: nextStatus('fail'),
      savedByWorkflow: true,
      success: false,
      error: routed.reason || 'human_dispatch',
    };
  }

  // HOOK(later-ws): embed enqueue — no-op until EmbedWorkflow is registered additively.
  const embed = await enqueueEmbedActivity({
    orgId: input.orgId,
    workItemId,
    conversationId: input.conversationId,
    businessKey: `${businessKey}:enqueueEmbed`,
  });
  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'embed_enqueued',
    actor: 'system',
    payload: { enqueued: embed.enqueued, noOp: embed.noOp },
    businessKey: `${businessKey}:embed_enqueued`,
  });

  // O7: PlanExecute pattern — wait BEFORE executeChild so send/pay/sign
  // tools cannot run until approveWorkItem. Greetings / read-only skip.
  const preHitl = resolveInboundHitlGate({ userMessage: input.userMessage });
  if (preHitl.wait) {
    await updateWorkItemStatusActivity({
      orgId: input.orgId,
      workItemId,
      status: nextStatus('await_confirm'),
      conversationId: input.conversationId,
      conversationStatus: 'needs_attention',
      businessKey: `${businessKey}:status_waiting_approval`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'confirm_requested',
      actor: 'system',
      payload: { classes: preHitl.classes, phase: 'before_tools' },
      businessKey: `${businessKey}:confirm_requested`,
    });
    await condition(() => lastConfirm !== undefined);
    if (lastConfirm === 'rejected') {
      await appendWorkEventActivity({
        orgId: input.orgId,
        workItemId,
        kind: eventKindForConfirm('rejected'),
        actor: 'owner',
        payload: { decision: 'rejected', classes: preHitl.classes },
        businessKey: `${businessKey}:confirm_rejected`,
      });
      await markNeedsAttentionActivity({
        orgId: input.orgId,
        workItemId,
        conversationId: input.conversationId,
        reason: 'hitl_rejected',
        businessKey: `${businessKey}:needs_attention`,
      });
      await updateWorkItemStatusActivity({
        orgId: input.orgId,
        workItemId,
        status: nextStatus('cancel'),
        businessKey: `${businessKey}:status_cancelled`,
      });
      return {
        workItemId,
        status: nextStatus('cancel'),
        savedByWorkflow: true,
        success: false,
        hitlDecision: 'rejected',
        error: 'hitl_rejected',
      };
    }
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: eventKindForConfirm('approved'),
      actor: 'owner',
      payload: { decision: 'approved', classes: preHitl.classes },
      businessKey: `${businessKey}:confirm_approved`,
    });
  }

  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'agent_started',
    actor: routed.employeeId || 'employee',
    payload: { sessionKey: sessionKeyForWorkItem(workItemId) },
    businessKey: `${businessKey}:agent_started`,
  });

  const childInput: AgentTaskInput = {
    orgId: input.orgId,
    conversationId: input.conversationId,
    channelId: input.channelId,
    employeeId: routed.employeeId,
    employeeName: routed.employeeName,
    employeeRole: routed.employeeRole,
    employeePersona: routed.employeePersona,
    toolAllowlist: routed.toolAllowlist,
    connectedChannels: input.connectedChannels,
    userMessage: input.userMessage,
    sessionKey: sessionKeyForWorkItem(workItemId),
    idempotencyKey: `${businessKey}:agent-turn`,
    skipPersist: false,
  };

  let childResult: AgentTaskResult;
  try {
    childResult = await executeChild(AutonomousAgentWorkflow, {
      workflowId: `${parentId}-turn`,
      args: [childInput],
      workflowExecutionTimeout: '20 minutes',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Compensation: log + needs_attention. Never silent-resend the channel reply.
    await markNeedsAttentionActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      reason: message,
      businessKey: `${businessKey}:needs_attention`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'agent_failed',
      actor: 'system',
      payload: { error: message.slice(0, 500) },
      businessKey: `${businessKey}:agent_failed`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'needs_attention',
      actor: 'system',
      payload: { reason: message.slice(0, 500) },
      businessKey: `${businessKey}:needs_attention_event`,
    });
    return {
      workItemId,
      status: nextStatus('fail'),
      savedByWorkflow: true,
      success: false,
      error: message,
    };
  }

  const reply = (childResult.replyMessage || '').trim();
  if (!childResult.success || !reply) {
    await markNeedsAttentionActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      reason: childResult.error || 'empty_reply',
      businessKey: `${businessKey}:needs_attention`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'needs_attention',
      actor: 'system',
      payload: { reason: childResult.error || 'empty_reply' },
      businessKey: `${businessKey}:needs_attention_event`,
    });
    return {
      workItemId,
      status: nextStatus('fail'),
      replyMessage: reply || undefined,
      executedSteps: childResult.executedSteps,
      savedByWorkflow: true,
      success: false,
      error: childResult.error || 'empty_reply',
    };
  }

  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'agent_replied',
    actor: routed.employeeId || 'employee',
    payload: { replyPreview: reply.slice(0, 200) },
    businessKey: `${businessKey}:agent_replied`,
  });

  const critic = await criticCheck({
    orgId: input.orgId,
    workItemId,
    draft: reply,
    intent: 'send',
    businessKey: `${businessKey}:criticCheck`,
  });
  if (!critic.allow) {
    await markNeedsAttentionActivity({
      orgId: input.orgId,
      workItemId,
      conversationId: input.conversationId,
      reason: critic.reason,
      businessKey: `${businessKey}:needs_attention`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'critic_blocked',
      actor: 'system',
      payload: { policy: critic.policy, reason: critic.reason, violations: critic.violations },
      businessKey: `${businessKey}:critic_blocked`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'needs_attention',
      actor: 'system',
      payload: { reason: critic.reason },
      businessKey: `${businessKey}:needs_attention_event`,
    });
    return {
      workItemId,
      status: nextStatus('fail'),
      executedSteps: childResult.executedSteps,
      savedByWorkflow: true,
      success: false,
      error: critic.reason,
    };
  }

  // Reply-class safety net only when we did not already wait before tools.
  // Leftover: agent-initiated send/pay/sign without user-message intent may
  // have already executed; this still withholds the customer-facing reply.
  const postHitl = resolveInboundHitlGate({
    userMessage: input.userMessage,
    reply,
    executedSteps: childResult.executedSteps,
    usedTools: childResult.usedTools,
  });
  if (!preHitl.wait && postHitl.wait) {
    await updateWorkItemStatusActivity({
      orgId: input.orgId,
      workItemId,
      status: nextStatus('await_confirm'),
      conversationId: input.conversationId,
      conversationStatus: 'needs_attention',
      businessKey: `${businessKey}:status_waiting_approval`,
    });
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: 'confirm_requested',
      actor: 'system',
      payload: { classes: postHitl.classes, phase: 'after_reply' },
      businessKey: `${businessKey}:confirm_requested`,
    });
    await condition(() => lastConfirm !== undefined);
    if (lastConfirm === 'rejected') {
      await appendWorkEventActivity({
        orgId: input.orgId,
        workItemId,
        kind: eventKindForConfirm('rejected'),
        actor: 'owner',
        payload: { decision: 'rejected', classes: postHitl.classes },
        businessKey: `${businessKey}:confirm_rejected`,
      });
      await markNeedsAttentionActivity({
        orgId: input.orgId,
        workItemId,
        conversationId: input.conversationId,
        reason: 'hitl_rejected',
        businessKey: `${businessKey}:needs_attention`,
      });
      await updateWorkItemStatusActivity({
        orgId: input.orgId,
        workItemId,
        status: nextStatus('cancel'),
        businessKey: `${businessKey}:status_cancelled`,
      });
      return {
        workItemId,
        status: nextStatus('cancel'),
        executedSteps: childResult.executedSteps,
        savedByWorkflow: true,
        success: false,
        hitlDecision: 'rejected',
        error: 'hitl_rejected',
      };
    }
    await appendWorkEventActivity({
      orgId: input.orgId,
      workItemId,
      kind: eventKindForConfirm('approved'),
      actor: 'owner',
      payload: { decision: 'approved', classes: postHitl.classes },
      businessKey: `${businessKey}:confirm_approved`,
    });
  }

  // M4: MemoryWriteBack as a child — off the webhook HTTP thread, not awaited.
  await startChild(MemoryWriteBackWorkflow, {
    workflowId: `${parentId}-writeback`,
    args: [
      {
        orgId: input.orgId,
        workItemId,
        conversationId: input.conversationId,
        closed: false,
        toolResults: childResult.executedSteps,
        businessKey: `${businessKey}:writeBackMemory`,
      },
    ],
    parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
    workflowExecutionTimeout: '10 minutes',
  });
  await appendWorkEventActivity({
    orgId: input.orgId,
    workItemId,
    kind: 'memory_writeback',
    actor: 'system',
    payload: { started: true, childWorkflowId: `${parentId}-writeback` },
    businessKey: `${businessKey}:memory_writeback`,
  });

  await updateWorkItemStatusActivity({
    orgId: input.orgId,
    workItemId,
    status: nextStatus('done'),
    businessKey: `${businessKey}:status_done`,
  });

  return {
    workItemId,
    status: nextStatus('done'),
    replyMessage: reply,
    executedSteps: childResult.executedSteps,
    savedByWorkflow: true,
    success: true,
    hitlDecision: preHitl.wait || postHitl.wait ? 'approved' : undefined,
  };
}
