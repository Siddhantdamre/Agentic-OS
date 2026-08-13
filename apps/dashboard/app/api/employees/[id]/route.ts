import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const { client, orgId } = await getScopedClient();
    try {
      const body = await request.json();
      const { name, role, persona, tool_allowlist, status } = body;

      const fields: string[] = [];
      const values: any[] = [id, orgId];
      let valIdx = 3;

      if (name !== undefined) {
        fields.push(`name = $${valIdx++}`);
        values.push(name);
      }
      if (role !== undefined) {
        fields.push(`role = $${valIdx++}`);
        values.push(role);
      }
      if (persona !== undefined) {
        fields.push(`persona = $${valIdx++}::jsonb`);
        values.push(JSON.stringify(typeof persona === 'string' ? persona : persona));
      }
      if (tool_allowlist !== undefined) {
        fields.push(`tool_allowlist = $${valIdx++}`);
        values.push(
          Array.isArray(tool_allowlist)
            ? tool_allowlist.filter((item: unknown): item is string => typeof item === 'string')
            : []
        );
      }
      if (status !== undefined) {
        fields.push(`status = $${valIdx++}`);
        values.push(status === 'paused' ? 'paused' : 'active');
      }

      fields.push(`updated_at = NOW()`);

      if (fields.length === 1) {
        return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
      }

      const query = `
        UPDATE ai_employees 
        SET ${fields.join(', ')} 
        WHERE id = $1 AND org_id = $2 
        RETURNING id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at
      `;

      const res = await client.query(query, values);
      if (res.rows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }

      return NextResponse.json({ employee: res.rows[0] });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/employees/[id] PATCH Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const { id } = params;
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        'DELETE FROM ai_employees WHERE id = $1 AND org_id = $2 RETURNING id',
        [id, orgId]
      );
      if (res.rows.length === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }
      return NextResponse.json({ success: true, deletedId: id });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/employees/[id] DELETE Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
