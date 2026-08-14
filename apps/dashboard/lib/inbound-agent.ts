import { getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { sendChannelReply, type ChannelReplyTarget } from '@/lib/channel-outbound';
import { evaluateInboundConfirm } from '@/lib/inbound-confirm';
import { runAutonomousAgentDirect } from '@darex/workflows/dist/atomic-agent-client';
import { runInboundDirectFallback } from '@darex/workflows/dist/inbound-hitl';
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
  hitlDecision?: 'approved' | 'rejected';
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
    case 'widget':
    case 'embed':
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
 * Prefer Temporal WorkItemWorkflow (wraps AutonomousAgentWorkflow). When
 * Temporal is down, greetings/read/draft still run immediately; send/pay/sign
 * persist `waiting_approval` and do not execute tools or send the action reply.
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
  let hitlDecision: 'approved' | 'rejected' | undefined;

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
      hitlDecision = result?.hitlDecision;
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
      const fallback = await runInboundDirectFallback(job.userMessage, {
        queueHitl: async (classes) => {
          console.warn(
            '[inbound-agent] Temporal down — queued send/pay/sign for HITL (did not execute tools). Retry WorkItemWorkflow start or signal approve later.',
            {
              conversationId: job.conversationId,
              classes,
              inboundEventId: job.inboundEventId,
            }
          );
          await persistTemporalDownHitlWait(job, channel, classes);
        },
        execute: async () => {
          const result = (await runAutonomousAgentDirect(agentInput)) as AgentTaskResult;
          return {
            reply: (result?.replyMessage || '').trim(),
            executedSteps: result?.executedSteps || [],
          };
        },
      });
      switch (fallback.kind) {
        case 'queued_hitl':
          return;
        case 'executed':
          reply = fallback.result.reply;
          executedSteps = fallback.result.executedSteps;
          break;
        default: {
          const _exhaustive: never = fallback;
          return _exhaustive;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[inbound-agent] Direct agent error (did not send):', message);
      return;
    }
  }

  if (!reply) {
    console.warn('[inbound-agent] Empty agent reply — not persisting or sending');
    return;
  }

  // S2: inbound-confirm — pause send/pay/sign unless WorkItem HITL already approved.
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
  if (confirm.pause && hitlDecision !== 'approved') {
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

async function persistTemporalDownHitlWait(
  job: InboundAgentJob,
  channel: WorkItemChannel,
  classes: string[]
): Promise<void> {
  const { client } = await getOrgScopedClient(job.orgId);
  let workItemId: string | null = null;
  const metadata = {
    temporalDown: true,
    hitlClasses: classes,
    inboundEventId: job.inboundEventId || null,
    phase: 'before_tools',
  };
  try {
    await client.query(
      `UPDATE conversations
          SET status = 'needs_attention', updated_at = NOW()
        WHERE id = $1 AND org_id = $2`,
      [job.conversationId, job.orgId]
    );

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM work_items WHERE org_id = $1 AND conversation_id = $2 LIMIT 1`,
      [job.orgId, job.conversationId]
    );
    if (existing.rows[0]?.id) {
      workItemId = existing.rows[0].id;
      await client.query(
        `UPDATE work_items
            SET status = 'waiting_approval',
                assignee_employee_id = COALESCE($1::uuid, assignee_employee_id),
                channel = COALESCE($2, channel),
                metadata = metadata || $3::jsonb
          WHERE id = $4 AND org_id = $5`,
        [job.employeeId || null, channel, JSON.stringify(metadata), workItemId, job.orgId]
      );
    } else {
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO work_items (
             org_id, type, status, assignee_employee_id, conversation_id, channel, metadata
           ) VALUES ($1, 'conversation', 'waiting_approval', $2, $3, $4, $5)
           RETURNING id`,
          [job.orgId, job.employeeId || null, job.conversationId, channel, JSON.stringify(metadata)]
        );
        workItemId = inserted.rows[0]?.id ?? null;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/unique|duplicate/i.test(message)) throw err;
        const again = await client.query<{ id: string }>(
          `SELECT id FROM work_items WHERE org_id = $1 AND conversation_id = $2 LIMIT 1`,
          [job.orgId, job.conversationId]
        );
        workItemId = again.rows[0]?.id ?? null;
        if (workItemId) {
          await client.query(
            `UPDATE work_items
                SET status = 'waiting_approval',
                    metadata = metadata || $1::jsonb
              WHERE id = $2 AND org_id = $3`,
            [JSON.stringify(metadata), workItemId, job.orgId]
          );
        }
      }
    }

    if (workItemId) {
      try {
        await client.query(
          `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
           VALUES ($1, $2, 'confirm_requested', $3::jsonb, 'system', $4)`,
          [
            job.orgId,
            workItemId,
            JSON.stringify({ classes, phase: 'before_tools', temporalDown: true }),
            `inbound-agent:temporal-down:${job.conversationId}:${job.inboundEventId || 'no-event'}`,
          ]
        );
      } catch {
        // Duplicate confirm_requested for the same inbound event is fine.
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[inbound-agent] Temporal down — HITL persist failed (did not execute tools):', message);
  } finally {
    client.release();
  }

  realtimeHub.publish(job.orgId, {
    type: 'needs_attention',
    conversationId: job.conversationId,
    message: `HITL wait (Temporal down): ${classes.join(',')}`.slice(0, 200),
    contactId: job.replyTarget?.contactId,
    channelType: job.replyTarget?.channelType,
  });
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
