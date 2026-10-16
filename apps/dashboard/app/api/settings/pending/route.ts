import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canReadOperations, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

function isMissingTable(err: unknown, table?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && (!table || message.includes(table));
}

export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canReadOperations(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      try {
        const res = await client.query(
          `SELECT id, workflow_id, action_type, employee_role, payload, status,
                  work_item_id, expires_at, created_at,
                  EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0 AS age_hours
             FROM agent_pending_actions
            WHERE org_id = $1 AND status = 'pending'
            ORDER BY created_at ASC`,
          [orgId]
        );
        return NextResponse.json({
          orgId,
          pending: res.rows.map((row) => ({
            id: row.id,
            workflowId: row.workflow_id,
            actionType: row.action_type,
            employeeRole: row.employee_role,
            payload: row.payload,
            status: row.status,
            workItemId: row.work_item_id,
            expiresAt: row.expires_at,
            createdAt: row.created_at,
            ageHours: Number(row.age_hours || 0),
          })),
        });
      } catch (err: unknown) {
        if (isMissingTable(err, 'agent_pending_actions')) {
          return NextResponse.json({ orgId, pending: [] });
        }
        throw err;
      }
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/settings/pending Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
