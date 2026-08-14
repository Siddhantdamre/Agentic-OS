import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { canReadAudit, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

/**
 * GET /api/audit — org-scoped audit_events.
 * Auditor may read. Never accepts body org_id (session org only).
 */
export async function GET(request: Request) {
  try {
    const scoped = await getScopedClient();
    const { client, orgId, userId } = scoped;
    try {
      const role = await loadHumanRole(client, userId);
      if (!canReadAudit(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const url = new URL(request.url);
      const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const kind = url.searchParams.get('kind');
      const workItemId = url.searchParams.get('workItemId');
      const planId = url.searchParams.get('planId');

      const params: unknown[] = [orgId];
      const where = ['org_id = $1'];
      if (kind) {
        params.push(kind);
        where.push(`kind = $${params.length}`);
      }
      if (workItemId) {
        params.push(workItemId);
        where.push(`work_item_id = $${params.length}`);
      }
      if (planId) {
        params.push(planId);
        where.push(`plan_id = $${params.length}`);
      }
      params.push(limit);

      const res = await client.query(
        `SELECT
           id, org_id, kind, actor_type, actor_user_id, actor_employee_id, actor_component,
           work_item_id, plan_id, confirm_id, approver_user_id,
           tool, action, risk_class, model, prompt_hash, langfuse_trace_id,
           result_status, data_classes, payload, created_at
         FROM audit_events
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params
      );

      return NextResponse.json({
        events: res.rows.map((row) => ({
          id: row.id,
          orgId: row.org_id,
          kind: row.kind,
          actorType: row.actor_type,
          actorUserId: row.actor_user_id,
          actorEmployeeId: row.actor_employee_id,
          actorComponent: row.actor_component,
          workItemId: row.work_item_id,
          planId: row.plan_id,
          confirmId: row.confirm_id,
          approverUserId: row.approver_user_id,
          tool: row.tool,
          action: row.action,
          riskClass: row.risk_class,
          model: row.model,
          promptHash: row.prompt_hash,
          langfuseTraceId: row.langfuse_trace_id,
          resultStatus: row.result_status,
          dataClasses: row.data_classes,
          payload: row.payload,
          createdAt: row.created_at,
        })),
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('GET /api/audit Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
