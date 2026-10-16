import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { queryAutomationRate } from '@/lib/automation-rate';
import { INSIGHT_METRIC_IDS, queryRegisteredMetrics } from '@/lib/insight-engine';

export const dynamic = 'force-dynamic';

const RANGE_INTERVALS: Record<string, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
};

export async function GET(req: NextRequest) {
  try {
    const { client, orgId } = await getScopedClient();
    const rangeKey = req.nextUrl.searchParams.get('range') || '7d';
    const intervalStr = RANGE_INTERVALS[rangeKey] || RANGE_INTERVALS['7d'];

    try {
      const convRes = await client.query(
        `SELECT COUNT(*) as total,
                COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active
         FROM conversations
         WHERE org_id = $1 AND started_at >= NOW() - $2::interval`,
        [orgId, intervalStr]
      );
      const totalConvs = parseInt(convRes.rows[0]?.total || '0', 10);
      const resolvedConvs = parseInt(convRes.rows[0]?.resolved || '0', 10);
      const activeConvs = parseInt(convRes.rows[0]?.active || '0', 10);

      const channelRes = await client.query(
        `SELECT channel_type, COUNT(*) as count
         FROM channels
         WHERE org_id = $1 AND status = 'active'
         GROUP BY channel_type`,
        [orgId]
      );

      const channelBreakdown = channelRes.rows.map((r: { channel_type: string; count: string }) => ({
        channel: r.channel_type,
        count: parseInt(r.count, 10),
      }));

      const msgRes = await client.query(
        `SELECT COUNT(*) as total_msgs FROM messages
         WHERE org_id = $1 AND created_at >= NOW() - $2::interval`,
        [orgId, intervalStr]
      );
      const totalMsgs = parseInt(msgRes.rows[0]?.total_msgs || '0', 10);

      // Bounded LATERAL latency scan — never full-history.
      const responseTimeRes = await client.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))) as avg_secs
         FROM (
           SELECT conversation_id, org_id, created_at
           FROM messages
           WHERE org_id = $1 AND role = 'user' AND created_at >= NOW() - $2::interval
           ORDER BY created_at DESC
           LIMIT 2000
         ) m1
         JOIN LATERAL (
           SELECT created_at FROM messages
           WHERE conversation_id = m1.conversation_id
             AND org_id = m1.org_id
             AND role = 'assistant'
             AND created_at > m1.created_at
           ORDER BY created_at ASC LIMIT 1
         ) m2 ON true`,
        [orgId, intervalStr]
      );
      const avgSecs = parseFloat(responseTimeRes.rows[0]?.avg_secs || '0');
      const avgResponseTime = avgSecs > 0 ? `${avgSecs.toFixed(1)}s` : 'N/A';

      const autoRateRes = await client.query(
        `SELECT
           COUNT(*) as total_assistant,
           COUNT(CASE WHEN tool_calls IS NOT NULL AND tool_calls != '[]' THEN 1 END) as with_tools
         FROM messages
         WHERE role = 'assistant' AND org_id = $1
           AND created_at >= NOW() - $2::interval`,
        [orgId, intervalStr]
      );
      const totalAssist = parseInt(autoRateRes.rows[0]?.total_assistant || '0', 10);
      const withTools = parseInt(autoRateRes.rows[0]?.with_tools || '0', 10);
      const toolExecutionRate =
        totalAssist > 0 ? `${((withTools / totalAssist) * 100).toFixed(1)}%` : '0%';

      const autoRate = await queryAutomationRate(client, orgId, intervalStr);
      const conversationAutomationRate = autoRate.rate === null ? 'N/A' : `${autoRate.rate}%`;
      const automationRate = conversationAutomationRate;

      const csatRes = await client.query(
        `SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved
         FROM conversations
         WHERE org_id = $1 AND started_at >= NOW() - $2::interval`,
        [orgId, intervalStr]
      );
      const totalConvsCsat = parseInt(csatRes.rows[0]?.total || '0', 10);
      const resolvedCsat = parseInt(csatRes.rows[0]?.resolved || '0', 10);
      const csatScore =
        totalConvsCsat > 0
          ? `${((resolvedCsat / totalConvsCsat) * 5).toFixed(1)} / 5`
          : 'N/A';

      const weekCurrentRes = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM conversations
         WHERE org_id = $1 AND started_at >= NOW() - $2::interval`,
        [orgId, intervalStr]
      );
      const weekPriorRes = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM conversations
         WHERE org_id = $1
           AND started_at >= NOW() - ($2::interval * 2)
           AND started_at < NOW() - $2::interval`,
        [orgId, intervalStr]
      );
      const weekCurrent = parseInt(String(weekCurrentRes.rows[0]?.count || '0'), 10);
      const weekPrior = parseInt(String(weekPriorRes.rows[0]?.count || '0'), 10);
      const conversationChangePct =
        weekPrior > 0 ? Math.round(((weekCurrent - weekPrior) / weekPrior) * 100) : null;

      const weeklyRes = await client.query(
        `SELECT TO_CHAR(started_at, 'Dy') as day, COUNT(*) as count
         FROM conversations
         WHERE org_id = $1 AND started_at >= NOW() - $2::interval
         GROUP BY TO_CHAR(started_at, 'Dy'), EXTRACT(DOW FROM started_at)
         ORDER BY EXTRACT(DOW FROM started_at)`,
        [orgId, intervalStr]
      );
      const dayOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const weeklyMap = new Map(
        weeklyRes.rows.map((r: { day: string; count: string }) => [r.day, parseInt(r.count, 10)])
      );
      const weeklyTrend = dayOrder.map((day) => ({ day, count: weeklyMap.get(day) || 0 }));

      const semantic = await queryRegisteredMetrics(client, orgId, [...INSIGHT_METRIC_IDS]);
      const byMetricId = Object.fromEntries(semantic.points.map((p) => [p.metricId, p.value]));

      return NextResponse.json({
        range: rangeKey in RANGE_INTERVALS ? rangeKey : '7d',
        metrics: {
          totalConversations: totalConvs,
          resolvedConversations: resolvedConvs,
          activeConversations: activeConvs,
          totalMessages: totalMsgs,
          automationRate,
          conversationAutomationRate,
          toolExecutionRate,
          avgResponseTime,
          csatScore,
          csatIsProxy: true,
          conversationChangePct,
        },
        metricIds: {
          openConversations: 'core.conversations_open',
          needsAttention: 'core.needs_attention',
          inboundMessages: 'core.messages_inbound',
          unworkedInquiries: 'core.inquiries_unworked',
          openWorkItems: 'core.work_items_open',
          revenueCollected7d: 'core.revenue_collected_7d',
        },
        metricPoints: semantic.points.map((p) => ({
          metricId: p.metricId,
          value: p.value,
          from: p.from,
          to: p.to,
        })),
        metricValues: byMetricId,
        gaps: semantic.gaps,
        source: 'sql+metrics.query',
        channelBreakdown,
        weeklyTrend,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/analytics Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
