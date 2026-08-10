import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    let orgName = 'Your Business';
    let channelCount = 0;
    let employeeCount = 0;
    let primaryEmployeeName = 'your AI employee';
    let primaryEmployeeRole = 'assistant';

    try {
      const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
      orgName = orgRes.rows[0]?.name || 'Your Business';

      const chanRes = await client.query("SELECT COUNT(*) FROM channels WHERE org_id = $1 AND status = 'active'", [orgId]);
      channelCount = parseInt(chanRes.rows[0]?.count || '0', 10);

      const empRes = await client.query(`SELECT name, role FROM ai_employees WHERE org_id = $1 AND status = 'active' LIMIT 1`, [orgId]);
      employeeCount = parseInt((await client.query('SELECT COUNT(*) FROM ai_employees WHERE org_id = $1', [orgId])).rows[0]?.count || '0', 10);
      const primaryEmployee = empRes.rows[0];
      primaryEmployeeName = primaryEmployee?.name || primaryEmployeeName;
      primaryEmployeeRole = primaryEmployee?.role || primaryEmployeeRole;
    } finally {
      client.release();
    }

    const insights = [
      {
        id: 'ins-1',
        category: 'Growth Opportunity',
        title: 'Google Calendar Auto-Booking Optimization',
        description: `Integrating Google Calendar allows ${primaryEmployeeName} (${primaryEmployeeRole}) to automatically schedule product demos and meetings directly inside WhatsApp conversations.`,
        impact: 'High (+conversion rate)',
        actionLabel: 'Connect Google Calendar',
        actionHref: '/connectors',
        type: 'growth',
      },
      {
        id: 'ins-2',
        category: 'Channel Efficiency',
        title: channelCount > 0 ? 'Multi-Channel Agent Coverage' : 'Connect Your First Channel',
        description: channelCount > 0
          ? `${primaryEmployeeName} is handling conversations across ${channelCount} active channel${channelCount > 1 ? 's' : ''}. Review SLA performance in Analytics to optimize response coverage.`
          : `No channels are connected yet. Connect WhatsApp, Gmail, or another channel to start receiving real customer messages.`,
        impact: channelCount > 0 ? 'Positive' : 'Action Required',
        actionLabel: channelCount > 0 ? 'View Analytics' : 'Connect a Channel',
        actionHref: channelCount > 0 ? '/analytics' : '/connectors',
        type: 'efficiency',
      },
      {
        id: 'ins-3',
        category: 'Channel Integration',
        title: channelCount < 3 ? 'Connect Additional Channels' : 'Multi-Channel Synchronization Active',
        description: channelCount < 3
          ? `You currently have ${channelCount} channel${channelCount !== 1 ? 's' : ''} connected. Adding HubSpot CRM or Meta Ads will enable cross-platform lead tracking.`
          : `All ${channelCount} channels are connected. Consider enabling Slack alerts for human-handoff notifications to your team.`,
        impact: 'Medium',
        actionLabel: 'Explore Connectors',
        actionHref: '/connectors',
        type: 'integration',
      },
    ];

    return NextResponse.json({ insights, orgName, channelCount, employeeCount });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/insight Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
