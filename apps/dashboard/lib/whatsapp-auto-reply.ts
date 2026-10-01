import { getOrgScopedClient } from '@/lib/db';
import { chatCompletion, type ChatMessage } from '@/lib/litellm-client';
import { deliverInboundReply, type InboundAgentJob } from '@/lib/inbound-agent';
import type { AutoReplyConfig } from '@/lib/whatsapp-auto-reply-config';

/**
 * WhatsApp auto-reply that does NOT use the AI-employee agent: no Temporal
 * workflow, no tools, no memory. Used when a connection is set to `fixed` or
 * `ai_simple` (see whatsapp-auto-reply-config.ts). Sending, saving and
 * delivery receipts go through the same deliverInboundReply as the agent.
 */

const HISTORY_LIMIT = 12;

export function simpleSystemPrompt(instructions: string): string {
  return [
    "You are a business's WhatsApp assistant. Reply to the customer's latest message.",
    'Rules:',
    '- Use only the business information below. If it does not cover the question, say a teammate will follow up. Do not guess.',
    '- Never invent prices, availability, offers or policies. Do not say something is unavailable unless the information says so.',
    '- Keep it under 80 words. Plain text, no markdown.',
    "- Reply in the customer's language.",
    'Business information:',
    instructions.trim() || '(none provided)',
  ].join('\n');
}

async function humanOrBotRepliedRecently(job: InboundAgentJob, minutes: number): Promise<boolean> {
  const { client } = await getOrgScopedClient(job.orgId);
  try {
    const res = await client.query(
      `SELECT 1 FROM messages
        WHERE org_id = $1 AND conversation_id = $2
          AND role IN ('assistant', 'human_agent')
          AND created_at > NOW() - make_interval(mins => $3::int)
        LIMIT 1`,
      [job.orgId, job.conversationId, minutes]
    );
    return (res.rowCount ?? res.rows.length) > 0;
  } finally {
    client.release();
  }
}

async function simpleAiReply(job: InboundAgentJob, cfg: AutoReplyConfig): Promise<string> {
  const { client } = await getOrgScopedClient(job.orgId);
  let history: Array<{ role: string; content: string }>;
  try {
    const res = await client.query(
      `SELECT role, content FROM messages
        WHERE org_id = $1 AND conversation_id = $2 AND role IN ('user', 'assistant', 'human_agent')
        ORDER BY created_at DESC LIMIT $3`,
      [job.orgId, job.conversationId, HISTORY_LIMIT]
    );
    history = (res.rows as Array<{ role: string; content: string }>).reverse();
  } finally {
    client.release();
  }
  const messages: ChatMessage[] = [{ role: 'system', content: simpleSystemPrompt(cfg.instructions) }];
  for (const row of history) {
    if (typeof row.content !== 'string' || !row.content.trim()) continue;
    messages.push({ role: row.role === 'user' ? 'user' : 'assistant', content: row.content });
  }
  // Inbound message is already saved; make sure it is the last turn.
  if (messages[messages.length - 1]?.role !== 'user') {
    messages.push({ role: 'user', content: job.userMessage });
  }
  return (
    await chatCompletion(messages, { maxTokens: 300, temperature: 0.3, timeoutMs: 30000, maxRetries: 1, orgId: job.orgId })
  ).trim();
}

export async function runWhatsAppAutoReply(job: InboundAgentJob): Promise<void> {
  const cfg = job.autoReply;
  if (!cfg) return;
  try {
    let reply = '';
    if (cfg.mode === 'fixed') {
      if (await humanOrBotRepliedRecently(job, cfg.cooldownMinutes)) return;
      reply = cfg.message;
    } else if (cfg.mode === 'ai_simple') {
      reply = await simpleAiReply(job, cfg);
    }
    if (!reply.trim()) {
      console.warn('[whatsapp-auto-reply] empty reply - nothing sent (%s)', cfg.mode);
      return;
    }
    await deliverInboundReply(job, reply.trim(), {
      executedSteps: [{ step: 1, action: `Auto-reply (${cfg.mode})`, result: 'no agent' }],
      savedByWorkflow: false,
      sendKey: `autoreply:${job.inboundEventId || job.conversationId}`,
    });
  } catch (err: unknown) {
    // Honest failure: no reply is invented. The inbound message is already saved and flagged.
    console.error('[whatsapp-auto-reply] failed (nothing sent):', err instanceof Error ? err.message : String(err));
  }
}
