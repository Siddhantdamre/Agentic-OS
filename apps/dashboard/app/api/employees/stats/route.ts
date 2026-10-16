import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const empRes = await client.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active
         FROM ai_employees
         WHERE org_id = $1`,
        [orgId]
      );
      const emp = empRes.rows[0] || { total: 0, active: 0 };

      const convRes = await client.query(
        `SELECT
           COUNT(*)::int AS total_convs,
           COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved_convs,
           COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - started_at)) * 1000), 0)::float AS avg_resolution_ms
         FROM conversations
         WHERE org_id = $1`,
        [orgId]
      );
      const conv = convRes.rows[0] || { total_convs: 0, resolved_convs: 0, avg_resolution_ms: 0 };

      const autoRes = await client.query(
        `SELECT
           COUNT(DISTINCT conversation_id) AS with_messages,
           COUNT(DISTINCT conversation_id) FILTER (WHERE role = 'assistant') AS ai_handled
         FROM messages
         WHERE org_id = $1`,
        [orgId]
      );
      const withMessages = parseInt(autoRes.rows[0]?.with_messages || '0', 10);
      const aiHandled = parseInt(autoRes.rows[0]?.ai_handled || '0', 10);
      const automationRate = withMessages > 0 ? Math.round((aiHandled / withMessages) * 100) : 0;

      return NextResponse.json({
        totalEmployees: emp.total,
        activeCount: emp.active,
        automationRate,
        avgResolutionSec: conv.avg_resolution_ms ? Number((conv.avg_resolution_ms / 1000).toFixed(1)) : 0,
        conversationsHandled: conv.total_convs,
        conversationsResolved: conv.resolved_convs,
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/employees/stats Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
