import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { loadHumanRole, type HumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

const WORK_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PATCHABLE_STATUS = [
  'open',
  'in_progress',
  'waiting_approval',
  'needs_attention',
  'done',
  'cancelled',
] as const;

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

function canMutateWorkItem(role: HumanRole): boolean {
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

function mapRow(row: Record<string, unknown>) {
  return {
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
  };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!WORK_ITEM_ID.test(id)) {
      return NextResponse.json({ error: 'Invalid work item id' }, { status: 400 });
    }

    const { client, orgId } = await getScopedClient();
    try {
      const itemRes = await client.query(
        `SELECT id, type, status, assignee_employee_id, assignee_user_id, depends_on_id,
                conversation_id, channel, priority, due_at, sla_due_at, sla_breached_at,
                metadata, payload, temporal_workflow_id, created_at, updated_at
           FROM work_items
          WHERE id = $1 AND org_id = $2`,
        [id, orgId]
      );
      if (itemRes.rowCount === 0) {
        return NextResponse.json({ error: 'Work item not found' }, { status: 404 });
      }

      let events: unknown[] = [];
      try {
        const eventsRes = await client.query(
          `SELECT id, kind, payload, actor, created_at
             FROM work_events
            WHERE work_item_id = $1 AND org_id = $2
            ORDER BY created_at ASC
            LIMIT 200`,
          [id, orgId]
        );
        events = eventsRes.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          payload: row.payload || {},
          actor: row.actor,
          createdAt: row.created_at,
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/work_events|does not exist|relation/i.test(message)) throw err;
      }

      return NextResponse.json({ workItem: mapRow(itemRes.rows[0]), events });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/work-items/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!WORK_ITEM_ID.test(id)) {
      return NextResponse.json({ error: 'Invalid work item id' }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canMutateWorkItem(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const sets: string[] = [];
      const values: unknown[] = [id, orgId];

      if (typeof body.status === 'string') {
        if (!(PATCHABLE_STATUS as readonly string[]).includes(body.status)) {
          return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
        }
        values.push(body.status);
        sets.push(`status = $${values.length}`);
      }
      if (typeof body.priority === 'string') {
        if (!(PRIORITIES as readonly string[]).includes(body.priority)) {
          return NextResponse.json({ error: 'Invalid priority' }, { status: 400 });
        }
        values.push(body.priority);
        sets.push(`priority = $${values.length}`);
      }
      if (body.assigneeEmployeeId === null) {
        values.push(null);
        sets.push(`assignee_employee_id = $${values.length}`);
      } else if (typeof body.assigneeEmployeeId === 'string') {
        values.push(body.assigneeEmployeeId);
        sets.push(`assignee_employee_id = $${values.length}`);
      }
      if (body.dueAt === null) {
        values.push(null);
        sets.push(`due_at = $${values.length}`);
      } else if (typeof body.dueAt === 'string') {
        values.push(body.dueAt);
        sets.push(`due_at = $${values.length}`);
      }
      if (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) {
        values.push(JSON.stringify(body.payload));
        sets.push(`payload = COALESCE(payload, '{}'::jsonb) || $${values.length}::jsonb`);
      }
      if (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)) {
        values.push(JSON.stringify(body.metadata));
        sets.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${values.length}::jsonb`);
      }
      if (body.assigneeUserId === null) {
        values.push(null);
        sets.push(`assignee_user_id = $${values.length}`);
      } else if (typeof body.assigneeUserId === 'string') {
        const member = await client.query(
          `SELECT id FROM users WHERE id = $1 AND org_id = $2 LIMIT 1`,
          [body.assigneeUserId, orgId]
        );
        if (!member.rows[0]) {
          return NextResponse.json(
            { error: 'assigneeUserId must be a member of this organization' },
            { status: 400 }
          );
        }
        values.push(body.assigneeUserId);
        sets.push(`assignee_user_id = $${values.length}`);
      }
      if (body.dependsOnId === null) {
        values.push(null);
        sets.push(`depends_on_id = $${values.length}`);
      } else if (typeof body.dependsOnId === 'string') {
        if (body.dependsOnId === id) {
          return NextResponse.json({ error: 'dependsOnId cannot reference itself' }, { status: 400 });
        }
        const dep = await client.query(
          `SELECT id FROM work_items WHERE id = $1 AND org_id = $2 LIMIT 1`,
          [body.dependsOnId, orgId]
        );
        if (!dep.rows[0]) {
          return NextResponse.json(
            { error: 'dependsOnId must reference a work item in this organization' },
            { status: 400 }
          );
        }
        values.push(body.dependsOnId);
        sets.push(`depends_on_id = $${values.length}`);
      }
      if (body.slaDueAt === null) {
        values.push(null);
        sets.push(`sla_due_at = $${values.length}`);
      } else if (typeof body.slaDueAt === 'string') {
        values.push(body.slaDueAt);
        sets.push(`sla_due_at = $${values.length}`);
      }

      if (sets.length === 0) {
        return NextResponse.json({ error: 'No valid update fields provided' }, { status: 400 });
      }

      sets.push('updated_at = NOW()');
      const res = await client.query(
        `UPDATE work_items
            SET ${sets.join(', ')}
          WHERE id = $1 AND org_id = $2
          RETURNING id, type, status, assignee_employee_id, assignee_user_id, depends_on_id,
                    conversation_id, channel, priority, due_at, sla_due_at, sla_breached_at,
                    metadata, payload, temporal_workflow_id, created_at, updated_at`,
        values
      );
      if (res.rowCount === 0) {
        return NextResponse.json({ error: 'Work item not found' }, { status: 404 });
      }

      try {
        await client.query(
          `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor, idempotency_key)
           VALUES ($1, $2, 'task_updated', $3::jsonb, $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            orgId,
            id,
            JSON.stringify({ fields: Object.keys(body).filter((k) => k !== 'org_id' && k !== 'orgId') }),
            userId,
            `updated:${id}:${Date.now()}`,
          ]
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/work_events|does not exist|relation/i.test(message)) {
          console.error('work_events insert failed:', err);
        }
      }

      realtimeHub.publish(orgId, { type: 'work_item_updated', message: id });
      return NextResponse.json({ workItem: mapRow(res.rows[0]) });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/work-items/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
