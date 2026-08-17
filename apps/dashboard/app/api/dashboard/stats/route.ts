import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  let client: any;
  try {
    const result = await getScopedClient();
    client = result.client;
    const { orgId, userId } = result;
    const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
    const orgName = orgRes.rows[0]?.name || 'Unknown Org';

    const userRes = await client.query('SELECT email, role FROM users WHERE id = $1', [userId]);
    const userEmail = userRes.rows[0]?.email || '';
    const userRole = userRes.rows[0]?.role || '';

    // Real conversation counts
    let conversationCount = 0;
    let conversationCountYesterday = 0;
    let needsAttentionCount = 0;
    let avgResponseMs: number | null = null;
    let aiAutomationRate: number | null = null;

    try {
      const convRes = await client.query(
        "SELECT COUNT(*) FROM conversations WHERE org_id = $1",
        [orgId]
      );
      conversationCount = parseInt(convRes.rows[0]?.count || '0', 10);

      // Yesterday's count (last 48h vs last 24h)
      const convYestRes = await client.query(
        `SELECT COUNT(*) FROM conversations WHERE org_id = $1 AND started_at >= NOW() - INTERVAL '48 hours' AND started_at < NOW() - INTERVAL '24 hours'`,
        [orgId]
      );
      conversationCountYesterday = parseInt(convYestRes.rows[0]?.count || '0', 10);

      // Needs attention count
      const needsRes = await client.query(
        "SELECT COUNT(*) FROM conversations WHERE org_id = $1 AND status = 'needs_attention'",
        [orgId]
      );
      needsAttentionCount = parseInt(needsRes.rows[0]?.count || '0', 10);

      // AI automation rate: ratio of conversations that have at least 1 assistant message
      const totalConvRes = await client.query(
        'SELECT COUNT(DISTINCT conversation_id) as total FROM messages WHERE org_id = $1',
        [orgId]
      );
      const aiHandledRes = await client.query(
        "SELECT COUNT(DISTINCT conversation_id) as ai_handled FROM messages WHERE org_id = $1 AND role = 'assistant'",
        [orgId]
      );
      const total = parseInt(totalConvRes.rows[0]?.total || '0', 10);
      const aiHandled = parseInt(aiHandledRes.rows[0]?.ai_handled || '0', 10);
      if (total > 0) {
        aiAutomationRate = Math.round((aiHandled / total) * 100);
      }

      // Average response time: time between user message and next assistant message
      const avgRes = await client.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (a.created_at - u.created_at)) * 1000) as avg_ms
         FROM messages u
         JOIN LATERAL (
           SELECT created_at FROM messages m2
           WHERE m2.conversation_id = u.conversation_id AND m2.org_id = u.org_id
             AND m2.role = 'assistant' AND m2.created_at > u.created_at
           ORDER BY m2.created_at ASC LIMIT 1
         ) a ON true
         WHERE u.role = 'user' AND u.org_id = $1`,
        [orgId]
      );
      const rawAvg = parseFloat(avgRes.rows[0]?.avg_ms || '0');
      avgResponseMs = rawAvg > 0 ? Math.round(rawAvg) : null;
    } catch (e) {
      console.warn('Stats computation error (non-critical):', e);
    }

    // Compute percent change vs yesterday
    let conversationChangePct: number | null = null;
    if (conversationCountYesterday > 0) {
      const todayConvRes = await client.query(
        `SELECT COUNT(*) FROM conversations WHERE org_id = $1 AND started_at >= NOW() - INTERVAL '24 hours'`,
        [orgId]
      ).catch(() => ({ rows: [{ count: '0' }] }));
      const todayCount = parseInt(todayConvRes.rows[0]?.count || '0', 10);
      conversationChangePct = Math.round(((todayCount - conversationCountYesterday) / conversationCountYesterday) * 100);
    }

    let channelCount = 0;
    try {
      const channelRes = await client.query(
        "SELECT COUNT(*) FROM channels WHERE org_id = $1 AND status = 'active'",
        [orgId]
      );
      channelCount = parseInt(channelRes.rows[0]?.count || '0', 10);
    } catch (e) {
      // Non-critical
    }

    let aiEmployees: any[] = [];
    let aiEmployeeCount = 0;
    try {
      const empRes = await client.query(
        'SELECT id, name, role, persona FROM ai_employees WHERE org_id = $1 LIMIT 6',
        [orgId]
      );

      aiEmployees = empRes.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        description: typeof row.persona === 'string' ? row.persona : row.persona?.text ?? '',
      }));
      const empCountRes = await client.query(
        'SELECT COUNT(*) FROM ai_employees WHERE org_id = $1',
        [orgId]
      );
      aiEmployeeCount = parseInt(empCountRes.rows[0]?.count || '0', 10);
    } catch (e) {
      // Non-critical
    }

    return NextResponse.json({
      orgName,
      userEmail,
      userRole,
      conversationCount,
      conversationChangePct,
      needsAttentionCount,
      avgResponseMs,
      aiAutomationRate,
      channelCount,
      aiEmployeeCount,
      aiEmployees,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Stats API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}
