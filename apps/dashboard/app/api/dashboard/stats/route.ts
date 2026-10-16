import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import type { PoolClient } from 'pg';
import { queryAutomationRate } from '@/lib/automation-rate';

export const dynamic = 'force-dynamic';

const STATS_CACHE_TTL_MS = 30_000;
const statsCache = new Map<string, { at: number; body: Record<string, unknown> }>();

/**
 * GET /api/dashboard/stats — org-scoped home briefing metrics.
 * Consolidated CTE + 30s in-process cache per org (no Redis required).
 */
export async function GET() {
  let client: PoolClient | null = null;
  try {
    const result = await getScopedClient();
    client = result.client;
    const { orgId, userId } = result;

    const cached = statsCache.get(orgId);
    if (cached && Date.now() - cached.at < STATS_CACHE_TTL_MS) {
      return NextResponse.json(cached.body, {
        headers: { 'Cache-Control': 'private, max-age=30' },
      });
    }

    const identityRes = await client.query(
      `SELECT
         (SELECT name FROM orgs WHERE id = $1) AS org_name,
         (SELECT email FROM users WHERE id = $2) AS user_email,
         (SELECT role FROM users WHERE id = $2) AS user_role`,
      [orgId, userId]
    );
    const orgName = identityRes.rows[0]?.org_name || 'Unknown Org';
    const userEmail = identityRes.rows[0]?.user_email || '';
    const userRole = identityRes.rows[0]?.user_role || '';

    let conversationCount = 0;
    let conversationChangePct: number | null = null;
    let needsAttentionCount = 0;
    let avgResponseMs: number | null = null;
    let aiAutomationRate: number | null = null;
    let channelCount = 0;
    let aiEmployees: Array<{
      id: string;
      name: string;
      role: string;
      description: string;
    }> = [];
    let aiEmployeeCount = 0;

    try {
      const statsRes = await client.query(
        `WITH conv_stats AS (
           SELECT
             COUNT(*)::int AS total_conversations,
             COUNT(*) FILTER (WHERE started_at >= NOW() - INTERVAL '24 hours')::int AS today_conversations,
             COUNT(*) FILTER (
               WHERE started_at >= NOW() - INTERVAL '48 hours'
                 AND started_at < NOW() - INTERVAL '24 hours'
             )::int AS yesterday_conversations,
             COUNT(*) FILTER (
               WHERE status IN ('needs_attention', 'pending_human')
             )::int AS needs_attention_count
           FROM conversations
           WHERE org_id = $1
         ),
         channel_stats AS (
           SELECT COUNT(*)::int AS active_channels
           FROM channels
           WHERE org_id = $1 AND status IN ('active', 'connected')
         ),
         emp_stats AS (
           SELECT COUNT(*)::int AS total_employees
           FROM ai_employees
           WHERE org_id = $1
         ),
         latency_stats AS (
           SELECT AVG(EXTRACT(EPOCH FROM (a.created_at - u.created_at)) * 1000) AS avg_ms
           FROM (
             SELECT conversation_id, org_id, created_at
             FROM messages
             WHERE org_id = $1 AND role = 'user' AND created_at > NOW() - INTERVAL '7 days'
             ORDER BY created_at DESC
             LIMIT 1000
           ) u
           JOIN LATERAL (
             SELECT created_at
             FROM messages m2
             WHERE m2.conversation_id = u.conversation_id
               AND m2.org_id = u.org_id
               AND m2.role = 'assistant'
               AND m2.created_at > u.created_at
             ORDER BY m2.created_at ASC
             LIMIT 1
           ) a ON true
         )
         SELECT
           c.total_conversations,
           c.today_conversations,
           c.yesterday_conversations,
           c.needs_attention_count,
           ch.active_channels,
           e.total_employees,
           l.avg_ms
         FROM conv_stats c
         CROSS JOIN channel_stats ch
         CROSS JOIN emp_stats e
         CROSS JOIN latency_stats l`,
        [orgId]
      );

      const row = statsRes.rows[0] || {};
      conversationCount = parseInt(String(row.total_conversations || '0'), 10);
      needsAttentionCount = parseInt(String(row.needs_attention_count || '0'), 10);
      channelCount = parseInt(String(row.active_channels || '0'), 10);
      aiEmployeeCount = parseInt(String(row.total_employees || '0'), 10);

      const todayCount = parseInt(String(row.today_conversations || '0'), 10);
      const yesterdayCount = parseInt(String(row.yesterday_conversations || '0'), 10);
      if (yesterdayCount > 0) {
        conversationChangePct = Math.round(
          ((todayCount - yesterdayCount) / yesterdayCount) * 100
        );
      }

      aiAutomationRate = (await queryAutomationRate(client, orgId, '7 days')).rate;

      const rawAvg = parseFloat(String(row.avg_ms || '0'));
      avgResponseMs = rawAvg > 0 ? Math.round(rawAvg) : null;

      const empRes = await client.query(
        `SELECT id, name, role, persona
         FROM ai_employees
         WHERE org_id = $1
         ORDER BY created_at ASC
         LIMIT 6`,
        [orgId]
      );
      aiEmployees = empRes.rows.map((emp) => ({
        id: emp.id,
        name: emp.name,
        role: emp.role,
        description:
          typeof emp.persona === 'string' ? emp.persona : emp.persona?.text ?? '',
      }));
    } catch (e) {
      console.warn('Stats computation error (non-critical):', e);
    }

    const body = {
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
    };
    statsCache.set(orgId, { at: Date.now(), body });

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, max-age=30' },
    });
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('Stats API Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}
