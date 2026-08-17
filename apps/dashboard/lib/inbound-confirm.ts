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

export type AuditActorInput =
  | { actorType: 'user'; userId: string }
  | { actorType: 'employee'; employeeId: string }
  | { actorType: 'system'; component: string };

export type AuditEventInsert = {
  orgId: string;
  kind:
    | 'tool.execute'
    | 'plan.approve'
    | 'plan.reject'
    | 'plan.execute'
    | 'connector.connect'
    | 'connector.disconnect'
    | 'memory.write'
    | 'memory.delete'
    | 'memory.correct'
    | 'pack.install'
    | 'pack.uninstall'
    | 'dsr.export'
    | 'dsr.delete'
    | 'role.change'
    | 'login'
    | 'confirm.override';
  actor: AuditActorInput;
  resultStatus: 'ok' | 'error' | 'denied';
  workItemId?: string | null;
  planId?: string | null;
  confirmId?: string | null;
  approverUserId?: string | null;
  tool?: string | null;
  action?: string | null;
  riskClass?: string | null;
  model?: string | null;
  promptHash?: string | null;
  langfuseTraceId?: string | null;
  dataClasses?: string[];
  payload?: Record<string, unknown>;
};

function actorColumns(actor: AuditActorInput): {
  actorType: string;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  actorComponent: string | null;
} {
  switch (actor.actorType) {
    case 'user':
      return {
        actorType: 'user',
        actorUserId: actor.userId,
        actorEmployeeId: null,
        actorComponent: null,
      };
    case 'employee':
      return {
        actorType: 'employee',
        actorUserId: null,
        actorEmployeeId: actor.employeeId,
        actorComponent: null,
      };
    case 'system':
      return {
        actorType: 'system',
        actorUserId: null,
        actorEmployeeId: null,
        actorComponent: actor.component,
      };
    default: {
      const _exhaustive: never = actor;
      return _exhaustive;
    }
  }
}

export async function recordAuditEvent(
  params: AuditEventInsert,
  scoped?: { client: PoolClient; orgId: string }
): Promise<void> {
  const run = async (client: PoolClient, orgId: string) => {
    if (orgId !== params.orgId) {
      throw new Error('recordAuditEvent orgId does not match scoped client');
    }
    const actor = actorColumns(params.actor);
    await client.query(
      `INSERT INTO audit_events (
         org_id, kind, actor_type, actor_user_id, actor_employee_id, actor_component,
         work_item_id, plan_id, confirm_id, approver_user_id,
         tool, action, risk_class, model, prompt_hash, langfuse_trace_id,
         result_status, data_classes, payload
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16,
         $17, $18, $19::jsonb
       )`,
      [
        params.orgId,
        params.kind,
        actor.actorType,
        actor.actorUserId,
        actor.actorEmployeeId,
        actor.actorComponent,
        params.workItemId ?? null,
        params.planId ?? null,
        params.confirmId ?? null,
        params.approverUserId ?? null,
        params.tool ?? null,
        params.action ?? null,
        params.riskClass ?? null,
        params.model ?? null,
        params.promptHash ?? null,
        params.langfuseTraceId ?? null,
        params.resultStatus,
        params.dataClasses ?? [],
        JSON.stringify(params.payload ?? {}),
      ]
    );
  };

  if (scoped) {
    await run(scoped.client, scoped.orgId);
    return;
  }

  const { client, orgId } = await getOrgScopedClient(params.orgId);
  try {
    await run(client, orgId);
  } finally {
    client.release();
  }
}

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
