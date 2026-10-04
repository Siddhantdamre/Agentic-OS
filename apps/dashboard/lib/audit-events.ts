/**
 * Shared append-only audit_events emit helper.
 * INSERT only — application code must never UPDATE or DELETE audit rows.
 * Org is always taken from the session-scoped client (getScopedClient /
 * getOrgScopedClient); never trust a body/query org_id.
 */
import type { PoolClient } from 'pg';
import { getOrgScopedClient } from '@/lib/db';

export type AuditActorInput =
  | { actorType: 'user'; userId: string }
  | { actorType: 'employee'; employeeId: string }
  | { actorType: 'system'; component: string };

/** Must match audit_events_kind_chk (migration 207); audit-events.test.ts pins it. */
export const AUDIT_EVENT_KINDS = [
  'tool.execute',
  'plan.approve',
  'plan.reject',
  'plan.execute',
  'connector.connect',
  'connector.disconnect',
  'memory.write',
  'memory.delete',
  'memory.correct',
  'pack.install',
  'pack.uninstall',
  'pack.upgrade',
  'pack.config_update',
  'dsr.export',
  'dsr.delete',
  'role.change',
  'login',
  'register',
  'logout',
  'password.reset',
  'invite.accept',
  'member.remove',
  'member.invite',
  'mfa.enable',
  'mfa.disable',
  'confirm.override',
  'settings.update',
  'org.switch',
  'employee.update',
  'employee.delete',
  'decision.approved',
  'decision.rejected',
  'decision.approved_and_executed',
  'decision.execution_failed',
  'decision.expired',
  'connector.config_update',
  'channel.create',
  'conversation.reply',
  'conversation.takeover',
  'conversation.resolve',
  'conversation.assign',
  'billing.change',
  'skill.update',
  'impersonation.start',
  'impersonation.end',
  'plan.cancel',
  'plan.step_edit',
  'tool.approve',
  'tool.deny',
  'crew.dispatch',
] as const;

export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export type AuditEventInsert = {
  orgId: string;
  kind: AuditEventKind;
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

/** SQL used by recordAuditEvent — tests assert INSERT-only (no UPDATE/DELETE). */
export const AUDIT_EVENT_INSERT_SQL = `INSERT INTO audit_events (
         org_id, kind, actor_type, actor_user_id, actor_employee_id, actor_component,
         work_item_id, plan_id, confirm_id, approver_user_id,
         tool, action, risk_class, model, prompt_hash, langfuse_trace_id,
         result_status, data_classes, payload
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16,
         $17, $18, $19::jsonb
       )`;

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

/**
 * Emit one audit_events row for the session org.
 * Pass `scoped` from getScopedClient() so the insert reuses the same RLS client.
 */
export async function recordAuditEvent(
  params: AuditEventInsert,
  scoped?: { client: PoolClient; orgId: string }
): Promise<void> {
  const run = async (client: PoolClient, orgId: string) => {
    if (orgId !== params.orgId) {
      throw new Error('recordAuditEvent orgId does not match scoped client');
    }
    const actor = actorColumns(params.actor);
    await client.query(AUDIT_EVENT_INSERT_SQL, [
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
    ]);
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
