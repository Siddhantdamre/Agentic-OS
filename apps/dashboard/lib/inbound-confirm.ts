/**
 * Webhook inbound confirm gate (WS-22 / S2 + S3).
 * Price / legal / pay / sign / publish / pack-banned → needs_attention, do not send.
 * Records audit_events (who approved is null until a human later approves).
 */
import type { PoolClient } from 'pg';
import { getOrgScopedClient } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import {
  evaluateConfirmClasses,
  primaryConfirmClass,
  type ConfirmEvalResult,
  type WebhookConfirmClass,
} from '@/lib/confirm-classes';
import {
  recordAuditEvent,
  type AuditActorInput,
  type AuditEventInsert,
} from '@/lib/audit-events';

/** Re-export shared audit emit helper (canonical home: lib/audit-events.ts). */
export { recordAuditEvent, type AuditActorInput, type AuditEventInsert };

export type InboundConfirmJob = {
  orgId: string;
  conversationId: string;
  employeeId?: string;
  reply: string;
  userMessage?: string;
  executedSteps?: unknown[];
  langfuseTraceId?: string | null;
  model?: string | null;
  contactId?: string | null;
  channelType?: string;
};

export type InboundConfirmDecision = {
  pause: boolean;
  classes: WebhookConfirmClass[];
  reason: string;
  eval: ConfirmEvalResult;
};

async function loadBannedPhrases(client: PoolClient, orgId: string): Promise<string[]> {
  try {
    const res = await client.query<{ phrases: unknown }>(
      `SELECT meta->'compliance'->'bannedPhrases' AS phrases FROM orgs WHERE id = $1 LIMIT 1`,
      [orgId]
    );
    const raw = res.rows[0]?.phrases;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  } catch {
    return [];
  }
}

async function markNeedsAttention(
  client: PoolClient,
  orgId: string,
  conversationId: string,
  reason: string
): Promise<string | null> {
  await client.query(
    `UPDATE conversations
        SET status = 'needs_attention', updated_at = NOW()
      WHERE id = $1 AND org_id = $2`,
    [conversationId, orgId]
  );

  let workItemId: string | null = null;
  try {
    const work = await client.query<{ id: string }>(
      `UPDATE work_items
          SET status = 'needs_attention', updated_at = NOW()
        WHERE conversation_id = $1 AND org_id = $2
        RETURNING id`,
      [conversationId, orgId]
    );
    workItemId = work.rows[0]?.id ?? null;
    if (workItemId) {
      try {
        await client.query(
          `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
           VALUES ($1, $2, 'needs_attention', $3::jsonb, 'system', $4)`,
          [
            orgId,
            workItemId,
            JSON.stringify({ reason, source: 'inbound-confirm' }),
            `inbound-confirm:${conversationId}:needs_attention`,
          ]
        );
      } catch {
        // Duplicate inbound-confirm event is fine.
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[inbound-confirm] work_item needs_attention skipped:', message);
  }
  return workItemId;
}

/**
 * If the draft must not auto-send, persist needs_attention + audit and return pause.
 * Callers must skip sendChannelReply when pause is true. Does not await LLM.
 */
export async function evaluateInboundConfirm(job: InboundConfirmJob): Promise<InboundConfirmDecision> {
  const { client, orgId } = await getOrgScopedClient(job.orgId);
  try {
    const bannedPhrases = await loadBannedPhrases(client, orgId);
    const evaluated = evaluateConfirmClasses({
      reply: job.reply,
      userMessage: job.userMessage,
      executedSteps: job.executedSteps,
      bannedPhrases,
    });

    if (!evaluated.pause) {
      return { pause: false, classes: [], reason: '', eval: evaluated };
    }

    const primary = primaryConfirmClass(evaluated);
    const reason = evaluated.hits[0]?.reason || `confirm class ${primary || 'unknown'}`;
    const workItemId = await markNeedsAttention(client, orgId, job.conversationId, reason);

    const actor: AuditActorInput = job.employeeId
      ? { actorType: 'employee', employeeId: job.employeeId }
      : { actorType: 'system', component: 'inbound-confirm' };

    try {
      await recordAuditEvent(
        {
          orgId,
          kind: 'tool.execute',
          actor,
          resultStatus: 'denied',
          workItemId,
          tool: 'inbound-channel',
          action: 'send',
          riskClass: primary,
          model: job.model ?? null,
          langfuseTraceId: job.langfuseTraceId ?? null,
          payload: {
            conversationId: job.conversationId,
            classes: evaluated.classes,
            hits: evaluated.hits,
            reason,
            paused: true,
          },
        },
        { client, orgId }
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[inbound-confirm] audit_events insert failed:', message);
    }

    realtimeHub.publish(orgId, {
      type: 'needs_attention',
      conversationId: job.conversationId,
      message: reason.slice(0, 200),
      contactId: job.contactId,
      channelType: job.channelType,
    });

    return { pause: true, classes: evaluated.classes, reason, eval: evaluated };
  } finally {
    client.release();
  }
}
