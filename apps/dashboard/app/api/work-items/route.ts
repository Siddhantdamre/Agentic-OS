import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { searchParams } = new URL(request.url);
      const type = searchParams.get('type');
      const priority = searchParams.get('priority');
      const assignee = searchParams.get('assignee');

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

      const res = await client.query(
        `SELECT id, type, status, assignee_employee_id, conversation_id, channel,
                priority, due_at, created_at, updated_at
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
          conversationId: row.conversation_id,
          channel: row.channel,
          priority: row.priority,
          dueAt: row.due_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/work_items|does not exist|relation/i.test(message)) {
      return NextResponse.json({ workItems: [] });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
