import { getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { sendChannelReply, type ChannelReplyTarget } from '@/lib/channel-outbound';

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
};

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
};

type AgentTaskResult = {
  replyMessage?: string;
  executedSteps?: unknown[];
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

/**
 * Fire-and-forget: HTTP handlers must return 200 before this work finishes.
 * Prefer Temporal start (workflow saves the assistant row); fall back to a
 * direct atomic-agent turn. Then send the reply on the inbound channel and
 * publish inbox SSE so the UI updates.
 */
export function fireInboundAgent(job: InboundAgentJob): void {
  void runInboundAgent(job);
}

async function runInboundAgent(job: InboundAgentJob): Promise<void> {
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
  };

  let reply = '';
  let savedByWorkflow = false;
  let executedSteps: unknown[] = [];

  try {
    const { startAutonomousAgentWorkflow } = await import('@darex/workflows/dist/workflow-client');
    const handle = await startAutonomousAgentWorkflow(agentInput);
    if (handle) {
      await persistWorkflowId(job.orgId, job.conversationId, handle.workflowId);
      const result = (await handle.result()) as AgentTaskResult;
      reply = (result?.replyMessage || '').trim();
      executedSteps = result?.executedSteps || [];
      savedByWorkflow = true;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[inbound-agent] Temporal unavailable, direct fallback:', message);
  }

  if (!savedByWorkflow) {
    try {
      const { runAutonomousAgentDirect } = await import('@darex/workflows/dist/atomic-agent-client');
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

  if (!savedByWorkflow) {
    await persistAssistantMessage(job.orgId, job.conversationId, reply, executedSteps);
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
  executedSteps: unknown[]
): Promise<void> {
  const { client } = await getOrgScopedClient(orgId);
  try {
    await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content, tool_calls, created_at)
       VALUES ($1, $2, 'assistant', $3, $4, NOW())`,
      [orgId, conversationId, reply, JSON.stringify(executedSteps)]
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
