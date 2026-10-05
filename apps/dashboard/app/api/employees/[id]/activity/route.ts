import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { id } = params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid employee id' }, { status: 400 });
    }
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '25', 10) || 25, 1), 50);

    const { client, orgId } = await getScopedClient();
    try {
      const emp = await client.query(
        `SELECT id FROM ai_employees WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      if (emp.rowCount === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }

      let activities: unknown[] = [];
      try {
        const res = await client.query(
          `SELECT wi.id, COALESCE(wi.metadata->>'title', wi.metadata->>'summary') AS title, wi.status, wi.priority, wi.type, wi.created_at, wi.updated_at
             FROM work_items wi
            WHERE wi.org_id = $1 AND wi.assignee_employee_id = $2
            ORDER BY wi.updated_at DESC
            LIMIT $3`,
          [orgId, id, limit],
        );
        activities = res.rows;
      } catch (err) {
        if ((err as { code?: string })?.code !== '42P01') throw err;
      }

      return NextResponse.json({ activities });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/employees/[id]/activity Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
