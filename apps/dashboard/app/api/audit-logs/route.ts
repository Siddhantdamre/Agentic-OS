import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canReadAudit, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

const SENSITIVE_KEY_RE =
  /password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential/i;

function redactPayloadPreview(raw: unknown): string {
  let text: string;
  try {
    if (typeof raw === 'string') text = raw;
    else text = JSON.stringify(raw ?? {});
  } catch {
    text = '[unserializable]';
  }
  // Strip obvious secret-looking JSON fields before truncating for the list UI.
  text = text.replace(
    /("?(?:password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)"?\s*:\s*")([^"]*)(")/gi,
    '$1[redacted]$3'
  );
  if (SENSITIVE_KEY_RE.test(text) && text.length > 400) {
    // Extra caution when sensitive keys appear — keep preview short.
    return text.slice(0, 200) + '…';
  }
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

/**
 * GET /api/audit-logs — org-scoped audit_events list with cursor pagination.
 * Session org only. Never accepts body org_id. Does not dump full payloads.
 */
export async function GET(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canReadAudit(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const url = new URL(request.url);
      const limitRaw = parseInt(url.searchParams.get('limit') || '50', 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
      const kind = url.searchParams.get('kind');
      const riskClass = url.searchParams.get('riskClass');
      const cursor = url.searchParams.get('cursor');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');

      const params: unknown[] = [orgId];
      const where = ['org_id = $1'];

      if (kind) {
        params.push(kind);
        where.push(`kind = $${params.length}`);
      }
      if (riskClass) {
        params.push(riskClass);
        where.push(`risk_class = $${params.length}`);
      }
      if (from) {
        const fromDate = new Date(from);
        if (!Number.isNaN(fromDate.getTime())) {
          params.push(fromDate.toISOString());
          where.push(`created_at >= $${params.length}::timestamptz`);
        }
      }
      if (to) {
        const toDate = new Date(to);
        if (!Number.isNaN(toDate.getTime())) {
          params.push(toDate.toISOString());
          where.push(`created_at <= $${params.length}::timestamptz`);
        }
      }
      if (cursor) {
        const [cursorTime, cursorId] = cursor.split('_');
        const cursorDate = cursorTime ? new Date(cursorTime) : null;
        if (cursorDate && !Number.isNaN(cursorDate.getTime()) && cursorId) {
          params.push(cursorDate.toISOString(), cursorId);
          where.push(
            `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
          );
        }
      }

      params.push(limit + 1);

      const res = await client.query(
        `SELECT
           id, kind, actor_type, actor_user_id, actor_employee_id, actor_component,
           work_item_id, plan_id, tool, action, risk_class, model,
           langfuse_trace_id, result_status, data_classes,
           SUBSTRING(COALESCE(payload::text, '') FROM 1 FOR 400) AS payload_preview,
           created_at
         FROM audit_events
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT $${params.length}`,
        params
      );

      const hasMore = res.rows.length > limit;
      const rows = hasMore ? res.rows.slice(0, limit) : res.rows;
      const last = rows[rows.length - 1];
      const nextCursor =
        hasMore && last
          ? `${new Date(last.created_at).toISOString()}_${last.id}`
          : null;

      return NextResponse.json({
        events: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          actorType: row.actor_type,
          actorUserId: row.actor_user_id,
          actorEmployeeId: row.actor_employee_id,
          actorComponent: row.actor_component,
          workItemId: row.work_item_id,
          planId: row.plan_id,
          tool: row.tool,
          action: row.action,
          riskClass: row.risk_class,
          model: row.model,
          langfuseTraceId: row.langfuse_trace_id,
          resultStatus: row.result_status,
          dataClasses: row.data_classes,
          payloadPreview: redactPayloadPreview(row.payload_preview),
          createdAt: row.created_at,
        })),
        nextCursor,
        limit,
        // Public base URL of the Langfuse UI for deep links; null when unset.
        langfuseBaseUrl: (process.env.LANGFUSE_HOST || '').trim().replace(/\/$/, '') || null,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/audit-logs Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
