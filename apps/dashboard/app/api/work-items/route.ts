import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { canReadOperations, loadHumanRole, type HumanRole } from '@/lib/rbac';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

function canCreateWorkItem(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'member':
      return true;
    case 'auditor':
    case 'billing':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canReadOperations(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const { searchParams } = new URL(request.url);
      const type = searchParams.get('type');
      const priority = searchParams.get('priority');
      const assignee = searchParams.get('assignee');
      const status = searchParams.get('status');

      const conditions = ['org_id = $1'];
      const params: unknown[] = [orgId];

      if (type) {
        params.push(type);
        conditions.push(`type = $${params.length}`);
      }
      if (priority) {
        params.push(priority);
        conditions.push(`priority = $${params.length}`);
      }
      if (assignee) {
        params.push(assignee);
        conditions.push(`assignee_employee_id = $${params.length}`);
      }
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }

      const humanAssignee = searchParams.get('assigneeUserId') || searchParams.get('assignee_user_id');
      if (humanAssignee) {
        params.push(humanAssignee);
        conditions.push(`assignee_user_id = $${params.length}`);
      }

      const res = await client.query(
        `SELECT id, type, status, assignee_employee_id, assignee_user_id, depends_on_id,
                conversation_id, channel, priority, due_at, sla_due_at, sla_breached_at,
                metadata, payload, temporal_workflow_id, created_at, updated_at
           FROM work_items
          WHERE ${conditions.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT 200`,
        params
      );

      return NextResponse.json({
        workItems: res.rows.map((row) => ({
          id: row.id,
          type: row.type,
          status: row.status,
          assigneeEmployeeId: row.assignee_employee_id,
          assigneeUserId: row.assignee_user_id,
          dependsOnId: row.depends_on_id,
          conversationId: row.conversation_id,
          channel: row.channel,
          priority: row.priority,
          dueAt: row.due_at,
          slaDueAt: row.sla_due_at,
          slaBreachedAt: row.sla_breached_at,
          metadata: row.metadata || {},
          payload: row.payload || {},
          temporalWorkflowId: row.temporal_workflow_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (/work_items|does not exist|relation/i.test(message)) {
      return NextResponse.json({ workItems: [] });
    }
    console.error('GET /api/work-items Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const title =
      typeof body.title === 'string'
        ? body.title.trim()
        : typeof body.summary === 'string'
          ? body.summary.trim()
          : '';
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const type = typeof body.type === 'string' && body.type.trim() ? body.type.trim() : 'task';
    const priorityRaw = typeof body.priority === 'string' ? body.priority : 'normal';
    const priority = (PRIORITIES as readonly string[]).includes(priorityRaw) ? priorityRaw : 'normal';
    const assigneeEmployeeId =
      typeof body.assigneeEmployeeId === 'string' ? body.assigneeEmployeeId : null;
    const assigneeUserId =
      typeof body.assigneeUserId === 'string' ? body.assigneeUserId : null;
    const dependsOnId =
      typeof body.dependsOnId === 'string' ? body.dependsOnId : null;
    const dueAt = typeof body.dueAt === 'string' ? body.dueAt : null;
    const slaDueAt = typeof body.slaDueAt === 'string' ? body.slaDueAt : null;
    const payload =
      body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};
    const metadata = {
      ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {}),
      title,
      summary: title,
    };

    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canCreateWorkItem(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      if (assigneeUserId) {
        const member = await client.query(
          `SELECT id FROM users WHERE id = $1 AND org_id = $2 LIMIT 1`,
          [assigneeUserId, orgId]
        );
        if (!member.rows[0]) {
          return NextResponse.json(
            { error: 'assigneeUserId must be a member of this organization' },
            { status: 400 }
          );
        }
      }
      if (dependsOnId) {
        const dep = await client.query(
          `SELECT id FROM work_items WHERE id = $1 AND org_id = $2 LIMIT 1`,
          [dependsOnId, orgId]
        );
        if (!dep.rows[0]) {
          return NextResponse.json(
            { error: 'dependsOnId must reference a work item in this organization' },
            { status: 400 }
          );
        }
      }

      const res = await client.query(
        `INSERT INTO work_items (
           org_id, type, status, priority, assignee_employee_id, assignee_user_id,
           depends_on_id, due_at, sla_due_at, metadata, payload
         ) VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
         RETURNING id, type, status, assignee_employee_id, assignee_user_id, depends_on_id,
                   conversation_id, channel, priority, due_at, sla_due_at, sla_breached_at,
                   metadata, payload, temporal_workflow_id, created_at, updated_at`,
        [
          orgId,
          type,
          priority,
          assigneeEmployeeId,
          assigneeUserId,
          dependsOnId,
          dueAt,
          slaDueAt,
          JSON.stringify(metadata),
          JSON.stringify(payload),
        ]
      );
      const row = res.rows[0];
      try {
        await client.query(
          `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
           VALUES ($1, $2, 'task_created', $3::jsonb, $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            orgId,
            row.id,
            JSON.stringify({ title, priority, type }),
            userId,
            `created:${row.id}:${Date.now()}`,
          ]
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/work_events|does not exist|relation/i.test(message)) {
          console.error('work_events insert failed:', err);
        }
      }

      realtimeHub.publish(orgId, { type: 'work_item_updated', message: String(row.id) });
      return NextResponse.json(
        {
          workItem: {
            id: row.id,
            type: row.type,
            status: row.status,
            assigneeEmployeeId: row.assignee_employee_id,
            assigneeUserId: row.assignee_user_id,
            dependsOnId: row.depends_on_id,
            conversationId: row.conversation_id,
            channel: row.channel,
            priority: row.priority,
            dueAt: row.due_at,
            slaDueAt: row.sla_due_at,
            slaBreachedAt: row.sla_breached_at,
            metadata: row.metadata || {},
            payload: row.payload || {},
            temporalWorkflowId: row.temporal_workflow_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        },
        { status: 201 }
      );
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('POST /api/work-items Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
