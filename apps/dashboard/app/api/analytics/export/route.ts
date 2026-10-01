import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/analytics/export — CSV of org analytics summary (session org only).
 * No secrets; scalars only.
 */
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const conv = await client.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active,
           COUNT(*) FILTER (WHERE status = 'needs_attention')::int AS needs_attention
         FROM conversations
         WHERE org_id = $1 AND started_at >= NOW() - INTERVAL '7 days'`,
        [orgId]
      );
      const channels = await client.query(
        `SELECT channel_type, COUNT(*)::int AS count
         FROM channels WHERE org_id = $1 AND status = 'active'
         GROUP BY channel_type ORDER BY count DESC`,
        [orgId]
      );
      const row = conv.rows[0] || {};
      const lines = [
        'metric,value',
        `org_id,${orgId}`,
        `window,7d`,
        `total_conversations,${row.total ?? 0}`,
        `resolved_conversations,${row.resolved ?? 0}`,
        `active_conversations,${row.active ?? 0}`,
        `needs_attention,${row.needs_attention ?? 0}`,
        ...channels.rows.map(
          (c: { channel_type: string; count: number }) =>
            `channel_${String(c.channel_type).replace(/[^a-z0-9_]/gi, '_')},${c.count}`
        ),
      ];
      return new NextResponse(lines.join('\n') + '\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="darex-analytics-7d.csv"',
          'Cache-Control': 'no-store',
        },
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/analytics/export Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
