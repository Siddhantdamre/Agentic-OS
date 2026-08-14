/** Universal work object + WorkItemWorkflow contracts. */

export const WORK_ITEM_STATUSES = [
  'open',
  'in_progress',
  'needs_attention',
  'waiting',
  'done',
  'cancelled',
  'failed',
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const WORK_ITEM_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export type WorkItemPriority = (typeof WORK_ITEM_PRIORITIES)[number];

export const CORE_WORK_ITEM_TYPES = [
  'conversation',
  'ticket',
  'deal',
  'task',
  'document',
  'event',
  'invoice',
] as const;

export type CoreWorkItemType = (typeof CORE_WORK_ITEM_TYPES)[number];

/** Core types plus pack-namespaced ids (`re.inquiry`, `pm.work_order`). */
export type WorkItemType = CoreWorkItemType | (string & {});

export const WORK_ITEM_TRIGGERS = [
  'message_inbound',
  'owner_ask_ai',
  'schedule',
  'threshold',
  'connector_event',
  'insight_action',
  'human_signal',
  'pack_install',
] as const;

export type WorkItemTrigger = (typeof WORK_ITEM_TRIGGERS)[number];

export const WORK_EVENT_KINDS = [
  'created',
  'status_changed',
  'assigned',
  'message',
  'plan_generated',
  'plan_approved',
  'plan_rejected',
  'tool_executed',
  'memory_updated',
  'human_takeover',
  'human_resume',
  'timer',
  'connector_event',
  'insight_action',
  'completed',
  'cancelled',
  'compensation',
] as const;

export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

export type WorkEventActor =
  | { actorType: 'user'; userId: string }
  | { actorType: 'employee'; employeeId: string }
  | { actorType: 'system'; component: string };

export interface EntityRef {
  entityType: string;
  entityId: string;
}

export interface WorkItem {
  id: string;
  orgId: string;
  type: WorkItemType;
  status: WorkItemStatus;
  assigneeEmployeeId?: string | null;
  entityRefs: EntityRef[];
  conversationId?: string | null;
  dueAt?: string | null;
  priority: WorkItemPriority;
  playbookId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface WorkEventBase {
  id: string;
  orgId: string;
  workItemId: string;
  actor: WorkEventActor;
  createdAt: string;
}

export type WorkEvent =
  | (WorkEventBase & { kind: 'created'; payload: { type: WorkItemType } })
  | (WorkEventBase & {
      kind: 'status_changed';
      payload: { from: WorkItemStatus; to: WorkItemStatus; reason?: string };
    })
  | (WorkEventBase & {
      kind: 'assigned';
      payload: { employeeId: string; previousEmployeeId?: string | null };
    })
  | (WorkEventBase & { kind: 'message'; payload: { messageId: string; channel?: string } })
  | (WorkEventBase & { kind: 'plan_generated'; payload: { planId: string } })
  | (WorkEventBase & {
      kind: 'plan_approved';
      payload: { planId: string; approverUserId: string };
    })
  | (WorkEventBase & {
      kind: 'plan_rejected';
      payload: { planId: string; actorUserId: string; reason?: string };
    })
  | (WorkEventBase & {
      kind: 'tool_executed';
      payload: { tool: string; action: string; status: string };
    })
  | (WorkEventBase & { kind: 'memory_updated'; payload: { citationIds?: string[] } })
  | (WorkEventBase & { kind: 'human_takeover'; payload: { userId: string } })
  | (WorkEventBase & { kind: 'human_resume'; payload: { userId: string } })
  | (WorkEventBase & { kind: 'timer'; payload: { timerId: string; fireAt: string } })
  | (WorkEventBase & {
      kind: 'connector_event';
      payload: { connectorKey: string; providerEventId: string };
    })
  | (WorkEventBase & {
      kind: 'insight_action';
      payload: { metricId: string; workflowName: string };
    })
  | (WorkEventBase & { kind: 'completed'; payload: { summary?: string } })
  | (WorkEventBase & { kind: 'cancelled'; payload: { reason?: string } })
  | (WorkEventBase & {
      kind: 'compensation';
      payload: { failedActivity: string; note: string };
    });

export interface WorkItemWorkflowInput {
  orgId: string;
  workItemId: string;
  trigger: WorkItemTrigger;
  conversationId?: string;
  channelId?: string;
  employeeId?: string;
  userMessage: string;
  sessionKey?: string;
  idempotencyKey?: string;
}

export interface WorkItemWorkflowResult {
  orgId: string;
  workItemId: string;
  status: WorkItemStatus;
  success: boolean;
  replyMessage?: string;
  error?: string;
}
