import { getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { sendChannelReply, type ChannelReplyTarget } from '@/lib/channel-outbound';
import { evaluateInboundConfirm } from '@/lib/inbound-confirm';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/atomic-agent-client';
import { startWorkItemWorkflow, signalNurtureCancelled } from '@darex/workflows/dist/workflow-client';

export type InboundAgentJob = {
  orgId: string;
  conversationId: string;
  channelId?: string;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  connectedChannels: string[];
  userMessage: string;
  replyTarget?: ChannelReplyTarget;
  /** Provider event id (Meta wamid / Chatwoot msg id). Dedupes Temporal + outbound send. */
  inboundEventId?: string;
  /** Unified surface key (H2). Does not replace replyTarget.channelType. */
  channelKey?: string;
};

type WorkItemChannel = 'whatsapp' | 'chatwoot' | 'inbox' | 'ask_ai' | 'unknown';

type AgentTaskInput = {
  orgId: string;
  conversationId: string;
  channelId?: string;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  connectedChannels: string[];
  userMessage: string;
  sessionKey?: string;
};

type AgentTaskResult = {
  replyMessage?: string;
  executedSteps?: unknown[];
};

type WorkItemTaskResult = AgentTaskResult & {
  workItemId?: string;
  savedByWorkflow?: boolean;
  success?: boolean;
};

export function parseToolAllowlist(value: unknown, fallback: string[] = ['whatsapp', 'gmail']): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function employeePersonaText(persona: unknown): string {
  if (persona == null) return 'Helpful customer support assistant.';
  if (typeof persona === 'string') {
    const trimmed = persona.trim();
    return trimmed || 'Helpful customer support assistant.';
  }
  if (typeof persona === 'object') {
    const rec = persona as Record<string, unknown>;
    for (const key of ['text', 'description', 'persona', 'system'] as const) {
      if (typeof rec[key] === 'string' && rec[key].trim()) return rec[key] as string;
    }
  }
  return 'Helpful customer support assistant.';
}

function workItemChannelFrom(channelType: string | undefined): WorkItemChannel {
  const normalized = (channelType || '').toLowerCase();
  switch (normalized) {
    case 'whatsapp':
      return 'whatsapp';
    case 'chatwoot':
      return 'chatwoot';
    case 'inbox':
    case 'dashboard':
      return 'inbox';
    case 'ask_ai':
      return 'ask_ai';
    case '':
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Fire-and-forget: HTTP handlers must return 200 before this work finishes.
 * Prefer Temporal WorkItemWorkflow (wraps AutonomousAgentWorkflow); fall back
 * to a direct atomic-agent turn when Temporal is down. Then send the reply
 * on the inbound channel and publish inbox SSE so the UI updates.
 */
export function fireInboundAgent(job: InboundAgentJob): void {
  void signalNurtureCancelled({
    orgId: job.orgId,
    conversationId: job.conversationId,
    reason: 'inbound',
  });
  void runInboundAgent(job);
}

async function runInboundAgent(job: InboundAgentJob): Promise<void> {
  const channel = workItemChannelFrom(job.channelKey || job.replyTarget?.channelType);
  const agentInput: AgentTaskInput = {
    orgId: job.orgId,
    conversationId: job.conversationId,
    channelId: job.channelId,
    employeeId: job.employeeId,
    employeeName: job.employeeName,
    employeeRole: job.employeeRole,
    employeePersona: job.employeePersona,
    toolAllowlist: job.toolAllowlist,
    connectedChannels: job.connectedChannels,
    userMessage: job.userMessage,
    sessionKey: job.conversationId,
  };

  let reply = '';
  let savedByWorkflow = false;
  let executedSteps: unknown[] = [];
  let workflowId: string | undefined;
  let startedWorkflow = false;

  try {
    const handle = await startWorkItemWorkflow({
      orgId: job.orgId,
      channel,
      conversationId: job.conversationId,
      inboundEventId: job.inboundEventId,
      channelId: job.channelId,
      employeeId: job.employeeId,
      employeeName: job.employeeName,
      employeeRole: job.employeeRole,
      employeePersona: job.employeePersona,
      toolAllowlist: job.toolAllowlist,
      connectedChannels: job.connectedChannels,
      userMessage: job.userMessage,
      idempotencyKey: job.inboundEventId,
    });
    if (handle) {
      startedWorkflow = true;
      workflowId = handle.workflowId;
      await persistWorkflowId(job.orgId, job.conversationId, handle.workflowId);
      const result = (await handle.result()) as WorkItemTaskResult;
      reply = (result?.replyMessage || '').trim();
      executedSteps = result?.executedSteps || [];
      savedByWorkflow = result?.savedByWorkflow !== false;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (startedWorkflow) {
      console.error('[inbound-agent] WorkItemWorkflow failed (no direct fallback, no resend):', message);
      return;
    }
    console.warn('[inbound-agent] Temporal unavailable, direct fallback:', message);
  }

  if (!savedByWorkflow && !startedWorkflow) {
    try {
      const result = (await runAutonomousAgentDirect(agentInput)) as AgentTaskResult;
      reply = (result?.replyMessage || '').trim();
      executedSteps = result?.executedSteps || [];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[inbound-agent] Direct agent error:', message);
      return;
    }
  }

  if (!reply) {
    console.warn('[inbound-agent] Empty agent reply — not persisting or sending');
    return;
  }

  // HOOK(ws-22/S2): inbound-confirm — pause send/pay/sign/publish/price/legal.
  const confirm = await evaluateInboundConfirm({
    orgId: job.orgId,
    conversationId: job.conversationId,
    employeeId: job.employeeId,
    reply,
    userMessage: job.userMessage,
    executedSteps,
    contactId: job.replyTarget?.contactId,
    channelType: job.replyTarget?.channelType,
  });
  if (confirm.pause) {
    if (!savedByWorkflow) {
      await persistAssistantMessage(job.orgId, job.conversationId, reply, executedSteps, job.channelKey);
    }
    console.warn('[inbound-agent] paused by confirm class:', confirm.reason);
    return;
  }

  const sendKey = workflowId || job.inboundEventId || `${job.conversationId}:${reply.slice(0, 80)}`;
  const claimed = await claimOutboundSend(job.orgId, sendKey);
  if (!claimed) {
    console.warn('[inbound-agent] Duplicate inbound event — skipping persist/send');
    return;
  }

  if (!savedByWorkflow) {
    await persistAssistantMessage(job.orgId, job.conversationId, reply, executedSteps, job.channelKey);
  }

  if (job.replyTarget) {
    await sendChannelReply(job.orgId, job.replyTarget, reply);
  }

  realtimeHub.publish(job.orgId, {
    type: 'conversation_updated',
    conversationId: job.conversationId,
    message: reply.slice(0, 200),
    contactId: job.replyTarget?.contactId,
    channelType: job.replyTarget?.channelType,
  });
  realtimeHub.publish(job.orgId, {
    type: 'message_received',
    conversationId: job.conversationId,
    message: reply.slice(0, 200),
    contactId: job.replyTarget?.contactId,
    channelType: job.replyTarget?.channelType,
  });
}

async function claimOutboundSend(orgId: string, businessKey: string): Promise<boolean> {
  const key = `${orgId}:sendChannelReply:${businessKey}`;
  const { client } = await getOrgScopedClient(orgId);
  try {
    const res = await client.query(
      `INSERT INTO idempotency_keys (key, org_id, result, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, orgId, JSON.stringify({ claimed: true })]
    );
    return res.rows.length > 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[inbound-agent] outbound send claim failed, allowing send:', message);
    return true;
  } finally {
    client.release();
  }
}

async function persistWorkflowId(orgId: string, conversationId: string, workflowId: string | undefined): Promise<void> {
  if (!workflowId) return;
  const { client } = await getOrgScopedClient(orgId);
  try {
    await client.query(
      `UPDATE conversations SET temporal_workflow_id = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
      [workflowId, conversationId, orgId]
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[inbound-agent] failed to store workflow id:', message);
  } finally {
    client.release();
  }
}

async function persistAssistantMessage(
  orgId: string,
  conversationId: string,
  reply: string,
  executedSteps: unknown[],
  channelKey?: string
): Promise<void> {
  const { client } = await getOrgScopedClient(orgId);
  try {
    await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls, channel_key, created_at)
       VALUES ($1, $2, 'assistant', $3, $4, $5, NOW())`,
      [orgId, conversationId, reply, JSON.stringify(executedSteps), channelKey || null]
    );
    await client.query(
      `UPDATE conversations SET updated_at = NOW(), summary = $1 WHERE id = $2 AND org_id = $3`,
      [reply.slice(0, 100), conversationId, orgId]
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[inbound-agent] failed to persist assistant message:', message);
  } finally {
    client.release();
  }
}
