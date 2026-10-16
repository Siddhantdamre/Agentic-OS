import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { loadEmployeePerformance } from '@/lib/employee-performance';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const { id } = params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid employee id' }, { status: 400 });
    }
    const { client, orgId } = await getScopedClient();
    try {
      const emp = await client.query(`SELECT id FROM ai_employees WHERE id = $1 AND org_id = $2`, [id, orgId]);
      if (emp.rowCount === 0) {
        return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
      }
      const metrics = await loadEmployeePerformance(client, orgId, id);
      return NextResponse.json({ metrics });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const scopedAuth = scopedAuthErrorResponse(error);
    if (scopedAuth) return scopedAuth;
    console.error('GET /api/employees/[id]/metrics Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
