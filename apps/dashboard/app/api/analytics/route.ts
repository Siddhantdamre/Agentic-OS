import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { INSIGHT_METRIC_IDS, queryRegisteredMetrics } from '@/lib/insight-engine';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const convRes = await client.query(
        `SELECT COUNT(*) as total,
                COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
                COUNT(CASE WHEN status = 'active' THEN 1 END) as active
         FROM conversations 
         WHERE org_id = $1`,
        [orgId]
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

      const channelBreakdown = channelRes.rows.map((r: any) => ({
        channel: r.channel_type,
        count: parseInt(r.count, 10),
      }));

      const msgRes = await client.query(
        `SELECT COUNT(*) as total_msgs FROM messages WHERE org_id = $1`,
        [orgId]
      );
      const totalMsgs = parseInt(msgRes.rows[0]?.total_msgs || '0', 10);

      // Real avg response time: time between user message and next assistant message
      const responseTimeRes = await client.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))) as avg_secs
         FROM messages m1
         JOIN LATERAL (
           SELECT created_at FROM messages
           WHERE conversation_id = m1.conversation_id
             AND org_id = m1.org_id
             AND role = 'assistant'
             AND created_at > m1.created_at
           ORDER BY created_at ASC LIMIT 1
         ) m2 ON true
         WHERE m1.role = 'user' AND m1.org_id = $1`,
        [orgId]
      );
      const avgSecs = parseFloat(responseTimeRes.rows[0]?.avg_secs || '0');
      const avgResponseTime = avgSecs > 0 ? `${avgSecs.toFixed(1)}s` : 'N/A';

      // Real automation rate: % of assistant messages that used tools
      const autoRateRes = await client.query(
        `SELECT
           COUNT(*) as total_assistant,
           COUNT(CASE WHEN tool_calls IS NOT NULL AND tool_calls != '[]' THEN 1 END) as with_tools
         FROM messages WHERE role = 'assistant' AND org_id = $1`,
        [orgId]
      );
      const totalAssist = parseInt(autoRateRes.rows[0]?.total_assistant || '0', 10);
      const withTools = parseInt(autoRateRes.rows[0]?.with_tools || '0', 10);
      const automationRate = totalAssist > 0 ? `${((withTools / totalAssist) * 100).toFixed(1)}%` : '0%';

      // Real CSAT: % of conversations resolved (vs total closed)
      const csatRes = await client.query(
        `SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved
         FROM conversations WHERE org_id = $1`,
        [orgId]
      );
      const totalConvsCsat = parseInt(csatRes.rows[0]?.total || '0', 10);
      const resolvedCsat = parseInt(csatRes.rows[0]?.resolved || '0', 10);
      const csatScore = totalConvsCsat > 0
        ? `${((resolvedCsat / totalConvsCsat) * 5).toFixed(1)} / 5`
        : 'N/A';

      const weekCurrentRes = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM conversations
         WHERE org_id = $1 AND started_at >= NOW() - INTERVAL '7 days'`,
        [orgId]
      );
      const weekPriorRes = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM conversations
         WHERE org_id = $1
           AND started_at >= NOW() - INTERVAL '14 days'
           AND started_at < NOW() - INTERVAL '7 days'`,
        [orgId]
      );
      const weekCurrent = parseInt(String(weekCurrentRes.rows[0]?.count || '0'), 10);
      const weekPrior = parseInt(String(weekPriorRes.rows[0]?.count || '0'), 10);
      const conversationChangePct =
        weekPrior > 0 ? Math.round(((weekCurrent - weekPrior) / weekPrior) * 100) : null;

      // Real weekly trend from DB
      const weeklyRes = await client.query(
        `SELECT TO_CHAR(started_at, 'Dy') as day, COUNT(*) as count
         FROM conversations
         WHERE org_id = $1 AND started_at >= NOW() - INTERVAL '7 days'
         GROUP BY TO_CHAR(started_at, 'Dy'), EXTRACT(DOW FROM started_at)
         ORDER BY EXTRACT(DOW FROM started_at)`,
        [orgId]
      );
      const dayOrder = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const weeklyMap = new Map(weeklyRes.rows.map((r: any) => [r.day, parseInt(r.count, 10)]));
      const weeklyTrend = dayOrder.map((day) => ({ day, count: weeklyMap.get(day) || 0 }));

      const semantic = await queryRegisteredMetrics(client, orgId, [...INSIGHT_METRIC_IDS]);
      const byMetricId = Object.fromEntries(semantic.points.map((p) => [p.metricId, p.value]));

      return NextResponse.json({
        metrics: {
          totalConversations: totalConvs,
          resolvedConversations: resolvedConvs,
          activeConversations: activeConvs,
          totalMessages: totalMsgs,
          automationRate,
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
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/analytics Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
