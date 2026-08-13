import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { getScopedClient } from '@/lib/db';
import { recordAuditEvent } from '@/lib/inbound-confirm';
import { canExportDsr, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

async function selectRows(
  client: PoolClient,
  sql: string,
  orgId: string
): Promise<Record<string, unknown>[]> {
  const res = await client.query(sql, [orgId]);
  return res.rows as Record<string, unknown>[];
}

/**
 * POST /api/dsr/export — org rows + memory + files list.
 * Org is always the session org. Body org_id is rejected.
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
      if (!canExportDsr(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const reqIns = await client.query<{ id: string }>(
        `INSERT INTO dsr_requests (
           org_id, kind, status, requested_by_user_id, include_memory, include_files, include_vectors
         ) VALUES ($1, 'export', 'running', $2, true, true, true)
         RETURNING id`,
        [orgId, userId]
      );
      const dsrRequestId = reqIns.rows[0].id;

      const org = (await selectRows(client, `SELECT id, name, slug, plan, status, created_at FROM orgs WHERE id = $1`, orgId))[0] || null;
      const users = await selectRows(
        client,
        `SELECT id, org_id, email, role, created_at FROM users WHERE org_id = $1`,
        orgId
      );
      const employees = await selectRows(
        client,
        `SELECT id, name, role, status, created_at FROM ai_employees WHERE org_id = $1`,
        orgId
      );
      const channels = await selectRows(
        client,
        `SELECT id, channel_type, status, created_at FROM channels WHERE org_id = $1`,
        orgId
      );
      const conversations = await selectRows(
        client,
        `SELECT id, contact_id, status, channel_id, created_at, updated_at FROM conversations WHERE org_id = $1`,
        orgId
      );
      const messages = await selectRows(
        client,
        `SELECT id, conversation_id, role, content, created_at FROM messages WHERE org_id = $1 ORDER BY created_at ASC`,
        orgId
      );
      const orgMemory = await selectRows(
        client,
        `SELECT id, kind, title, body, source, source_ref, content_hash,
                (embedding IS NOT NULL) AS has_embedding, created_at, updated_at
           FROM org_memory WHERE org_id = $1`,
        orgId
      );
      const employeeMemory = await selectRows(
        client,
        `SELECT id, employee_id, kind, title, body, source, source_ref,
                (embedding IS NOT NULL) AS has_embedding, created_at
           FROM employee_memory WHERE org_id = $1`,
        orgId
      );
      const entityMemory = await selectRows(
        client,
        `SELECT id, entity_type, entity_id, kind, title, body,
                (embedding IS NOT NULL) AS has_embedding, created_at
           FROM entity_memory WHERE org_id = $1`,
        orgId
      );
      const conversationMemory = await selectRows(
        client,
        `SELECT id, conversation_id, kind, title, body,
                (embedding IS NOT NULL) AS has_embedding, created_at
           FROM conversation_memory WHERE org_id = $1`,
        orgId
      );
      const memoryEdges = await selectRows(
        client,
        `SELECT id, from_id, to_id, from_kind, to_kind, rel FROM memory_edges WHERE org_id = $1`,
        orgId
      );
      const files = await selectRows(
        client,
        `SELECT id, connector, path, status, last_synced AS last_synced, created_at
           FROM knowledge_sources WHERE org_id = $1`,
        orgId
      );
      const workItems = await selectRows(
        client,
        `SELECT id, type, status, conversation_id, created_at FROM work_items WHERE org_id = $1`,
        orgId
      );
      const plans = await selectRows(
        client,
        `SELECT id, summary, status, created_at FROM agent_plans WHERE org_id = $1`,
        orgId
      );

      const exportPayload = {
        org,
        users,
        employees,
        channels,
        conversations,
        messages,
        memory: {
          org: orgMemory,
          employee: employeeMemory,
          entity: entityMemory,
          conversation: conversationMemory,
          edges: memoryEdges,
        },
        files,
        workItems,
        plans,
        exportedAt: new Date().toISOString(),
      };

      await client.query(
        `UPDATE dsr_requests
            SET status = 'completed', completed_at = NOW(), result = $3::jsonb
          WHERE id = $1 AND org_id = $2`,
        [dsrRequestId, orgId, JSON.stringify({ counts: {
          users: users.length,
          conversations: conversations.length,
          messages: messages.length,
          memory: orgMemory.length + employeeMemory.length + entityMemory.length + conversationMemory.length,
          files: files.length,
        } })]
      );

      await recordAuditEvent(
        {
          orgId,
          kind: 'dsr.export',
          actor: { actorType: 'user', userId },
          resultStatus: 'ok',
          payload: { dsrRequestId },
        },
        { client, orgId }
      );

      return NextResponse.json({
        dsrRequestId,
        status: 'completed',
        export: exportPayload,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/dsr/export Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
