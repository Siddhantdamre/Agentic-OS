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
    let needsAttention = 0;
    let pausedCount = 0;

    try {
      const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
      orgName = orgRes.rows[0]?.name || 'Your Business';

      const chanRes = await client.query("SELECT COUNT(*) FROM channels WHERE org_id = $1 AND status = 'active'", [orgId]);
      channelCount = parseInt(chanRes.rows[0]?.count || '0', 10);

      const empRes = await client.query(
        `SELECT name, role, status FROM ai_employees WHERE org_id = $1 ORDER BY created_at ASC`,
        [orgId]
      );
      employeeCount = empRes.rows.length;
      const activeEmployees = empRes.rows.filter((row: { status: string }) => row.status === 'active');
      const pausedEmployees = empRes.rows.filter((row: { status: string }) => row.status === 'paused');
      pausedCount = pausedEmployees.length;
      const primaryEmployee = activeEmployees[0];
      primaryEmployeeName = primaryEmployee?.name || primaryEmployeeName;
      primaryEmployeeRole = primaryEmployee?.role || primaryEmployeeRole;

      const needsRes = await client.query(
        `SELECT COUNT(*)::int AS count FROM conversations WHERE org_id = $1 AND status = 'needs_attention'`,
        [orgId]
      );
      needsAttention = parseInt(String(needsRes.rows[0]?.count || '0'), 10);
    } finally {
      client.release();
    }

    const insights = [
      {
        id: 'ins-1',
        category: 'Queue',
        title: needsAttention > 0
          ? `${needsAttention} conversation${needsAttention === 1 ? '' : 's'} need human review`
          : employeeCount === 0
            ? 'No AI employees in the roster yet'
            : `${primaryEmployeeName} (${primaryEmployeeRole}) is on the active roster`,
        description: needsAttention > 0
          ? 'These threads are marked needs_attention. Open Conversations to take them — this count is from SQL, not a forecast.'
          : employeeCount === 0
            ? 'Open Employees to seed the default roster or hire a custom employee. Nothing is auto-invented here.'
            : `${pausedCount} employee${pausedCount === 1 ? ' is' : 's are'} paused. Tool access is whatever you assigned on the Employees page.`,
        impact: needsAttention > 0 ? 'Action required' : 'Informational',
        actionLabel: needsAttention > 0 ? 'Open inbox' : 'Open employees',
        actionHref: needsAttention > 0 ? '/conversations' : '/employees',
        type: needsAttention > 0 ? 'attention' : 'growth',
      },
      {
        id: 'ins-2',
        category: 'Channel Efficiency',
        title: channelCount > 0 ? 'Multi-Channel Agent Coverage' : 'Connect Your First Channel',
        description: channelCount > 0
          ? `${primaryEmployeeName} is handling conversations across ${channelCount} active channel${channelCount > 1 ? 's' : ''}. Review SLA performance in Analytics to optimize response coverage.`
          : `No channels are connected yet. Connect WhatsApp, Gmail, or another channel to start receiving real customer messages.`,
        impact: channelCount > 0 ? 'Informational' : 'Action required',
        actionLabel: channelCount > 0 ? 'View Analytics' : 'Connect a Channel',
        actionHref: channelCount > 0 ? '/analytics' : '/connectors',
        type: 'efficiency',
      },
      {
        id: 'ins-3',
        category: 'Channel Integration',
        title: channelCount < 3 ? 'Connect Additional Channels' : 'Multi-Channel Synchronization Active',
        description: channelCount < 3
          ? `You currently have ${channelCount} active channel${channelCount !== 1 ? 's' : ''}. Extra connectors stay disconnected until OAuth succeeds — Darex will not pretend they are live.`
          : `${channelCount} channels are active. This is a count of channels.status = active, not a sync health check.`,
        impact: channelCount === 0 ? 'Blocked' : 'Informational',
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
