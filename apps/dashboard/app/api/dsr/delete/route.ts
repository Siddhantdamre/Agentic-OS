import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { getScopedClient } from '@/lib/db';
import { recordAuditEvent } from '@/lib/inbound-confirm';
import { canDeleteDsr, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

async function deleteOrgRows(client: PoolClient, orgId: string, sql: string): Promise<number> {
  const res = await client.query(sql, [orgId]);
  return res.rowCount ?? 0;
}

/**
 * POST /api/dsr/delete — hard-delete org memory including pgvector embeddings.
 * Neighbor orgs are untouched (RLS + org_id bind from session, never body).
 */
export async function POST(request: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const scoped = await getScopedClient();
    const { client, orgId, userId } = scoped;
    try {
      const role = await loadHumanRole(client, userId);
      if (!canDeleteDsr(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const reqIns = await client.query<{ id: string }>(
        `INSERT INTO dsr_requests (
           org_id, kind, status, requested_by_user_id,
           include_memory, include_files, include_vectors
         ) VALUES ($1, 'delete', 'running', $2, true, true, true)
         RETURNING id`,
        [orgId, userId]
      );
      const dsrRequestId = reqIns.rows[0].id;

      const deleted: Record<string, number> = {};
      try {
        deleted.memory_edges = await deleteOrgRows(client, orgId, `DELETE FROM memory_edges WHERE org_id = $1`);
        deleted.ingestion_jobs = await deleteOrgRows(client, orgId, `DELETE FROM ingestion_jobs WHERE org_id = $1`);
        deleted.knowledge_sources = await deleteOrgRows(
          client,
          orgId,
          `DELETE FROM knowledge_sources WHERE org_id = $1`
        );
        deleted.org_memory = await deleteOrgRows(client, orgId, `DELETE FROM org_memory WHERE org_id = $1`);
        deleted.employee_memory = await deleteOrgRows(client, orgId, `DELETE FROM employee_memory WHERE org_id = $1`);
        deleted.entity_memory = await deleteOrgRows(client, orgId, `DELETE FROM entity_memory WHERE org_id = $1`);
        deleted.conversation_memory = await deleteOrgRows(
          client,
          orgId,
          `DELETE FROM conversation_memory WHERE org_id = $1`
        );
        deleted.work_events = await deleteOrgRows(client, orgId, `DELETE FROM work_events WHERE org_id = $1`);
        deleted.work_items = await deleteOrgRows(client, orgId, `DELETE FROM work_items WHERE org_id = $1`);
        deleted.messages = await deleteOrgRows(client, orgId, `DELETE FROM messages WHERE org_id = $1`);
        deleted.conversations = await deleteOrgRows(client, orgId, `DELETE FROM conversations WHERE org_id = $1`);
        deleted.agent_plans = await deleteOrgRows(client, orgId, `DELETE FROM agent_plans WHERE org_id = $1`);
        deleted.channel_logs = await deleteOrgRows(client, orgId, `DELETE FROM channel_logs WHERE org_id = $1`);
        deleted.idempotency_keys = await deleteOrgRows(client, orgId, `DELETE FROM idempotency_keys WHERE org_id = $1`);

        await client.query(
          `UPDATE dsr_requests
              SET status = 'completed', completed_at = NOW(), result = $3::jsonb
            WHERE id = $1 AND org_id = $2`,
          [dsrRequestId, orgId, JSON.stringify({ deleted, includeVectors: true })]
        );

        await recordAuditEvent(
          {
            orgId,
            kind: 'dsr.delete',
            actor: { actorType: 'user', userId },
            resultStatus: 'ok',
            payload: { dsrRequestId, deleted, includeVectors: true },
          },
          { client, orgId }
        );

        return NextResponse.json({
          dsrRequestId,
          status: 'completed',
          includeVectors: true,
          deleted,
        });
      } catch (inner: unknown) {
        const message = inner instanceof Error ? inner.message : String(inner);
        await client.query(
          `UPDATE dsr_requests
              SET status = 'failed', error = $3, completed_at = NOW()
            WHERE id = $1 AND org_id = $2`,
          [dsrRequestId, orgId, message.slice(0, 500)]
        );
        throw inner;
      }
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/dsr/delete Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
