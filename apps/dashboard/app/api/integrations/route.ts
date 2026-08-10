import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

// All 14 supported connectivity tools
const ALL_INTEGRATIONS = [
  { id: 'whatsapp', name: 'WhatsApp Business', category: 'Messaging', icon: 'MessageSquare', desc: 'Meta Cloud API for inbound & outbound WhatsApp customer messaging' },
  { id: 'gmail', name: 'Gmail / Email', category: 'Email', icon: 'Mail', desc: 'Inbound email triage & outbound response drafting via Gmail API' },
  { id: 'google-calendar', name: 'Google Calendar', category: 'Calendar', icon: 'Calendar', desc: 'Real-time slot checking & appointment booking' },
  { id: 'google-ads', name: 'Google Ads', category: 'Advertising', icon: 'BarChart2', desc: 'Search campaign analytics, conversion logging & ROAS metrics' },
  { id: 'meta-ads', name: 'Meta Ads', category: 'Advertising', icon: 'Megaphone', desc: 'ROAS tracking & Meta ad campaign performance monitoring' },
  { id: 'hubspot', name: 'HubSpot CRM', category: 'CRM', icon: 'Database', desc: 'Automatic contact creation, deal stage updates & lead tracking' },
  { id: 'stripe', name: 'Stripe Payments', category: 'Payments', icon: 'CreditCard', desc: 'Subscription tracking, payment links & customer billing sync' },
  { id: 'notion', name: 'Notion Workspace', category: 'Knowledge', icon: 'BookOpen', desc: 'Sync knowledge bases, product docs & team task databases' },
  { id: 'slack', name: 'Slack Notifications', category: 'Messaging', icon: 'Slack', desc: 'Team alerts, channel notifications & human-handoff triggers' },
  { id: 'shopify', name: 'Shopify Store', category: 'E-Commerce', icon: 'ShoppingBag', desc: 'Order tracking, inventory queries & customer fulfillment sync' },
  { id: 'zendesk', name: 'Zendesk Support', category: 'Support', icon: 'Headphones', desc: 'Helpdesk ticket creation & customer escalation sync' },
  { id: 'intercom', name: 'Intercom Inbox', category: 'Support', icon: 'MessageCircle', desc: 'Live customer chat sync & agent assignment' },
  { id: 'github', name: 'GitHub Code', category: 'Development', icon: 'Github', desc: 'Repository sync, pull request logs & issue tracking' },
  { id: 'razorpay', name: 'Razorpay Invoices', category: 'Payments', icon: 'CreditCard', desc: 'Instant payment link generation & invoice status queries' },
];

// ── GET: Ultra-fast batch fetch of integrations for current orgId ─────────────
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      // Fetch channels from DB strictly for current org_id
      const channelsRes = await client.query(
        `SELECT channel_type, status, nango_connection_id, connected_at FROM channels WHERE org_id = $1`,
        [orgId]
      );
      const dbChannelsMap = new Map(channelsRes.rows.map((r: any) => [r.channel_type, r]));

      const integrations = ALL_INTEGRATIONS.map((item) => {
        const dbRecord = dbChannelsMap.get(item.id) as any;
        const isConnected = dbRecord && (dbRecord.status === 'active' || dbRecord.status === 'connected');

        return {
          ...item,
          connected: Boolean(isConnected),
          status: isConnected ? 'Connected' : 'Disconnected',
          nangoConnectionId: dbRecord?.nango_connection_id || (isConnected ? `${orgId}_${item.id}` : null),
          lastSyncedAt: dbRecord?.connected_at || null,
        };
      });

      // Fetch stats & logs
      const todayLogsRes = await client.query(
        `SELECT status, count(*) as count FROM channel_logs WHERE org_id = $1 AND created_at >= CURRENT_DATE GROUP BY status`,
        [orgId]
      );

      let totalSyncsToday = 0;
      let failedWebhooks = 0;
      todayLogsRes.rows.forEach((row: any) => {
        const count = parseInt(row.count, 10);
        totalSyncsToday += count;
        if (row.status === 'error' || row.status === 'failed') {
          failedWebhooks += count;
        }
      });

      const connectedCount = integrations.filter((i) => i.connected).length;
      const apiQuotaPct = Math.min(100, parseFloat(((totalSyncsToday / 1000) * 100).toFixed(1)));

      const logsRes = await client.query(
        `SELECT channel_type, event_type, status, status_code, message, created_at
         FROM channel_logs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [orgId]
      );

      return NextResponse.json({
        integrations,
        stats: {
          connectedApps: connectedCount,
          totalSyncsToday,
          failedWebhooks,
          apiQuotaUsed: `${apiQuotaPct}%`,
        },
        logs: logsRes.rows,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Integrations GET error:', err);
    return NextResponse.json({ message: err.message, integrations: [], stats: {}, logs: [] }, { status: 500 });
  }
}

// ── POST: Connect or Disconnect an integration for current orgId ──────────────
export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { provider, action } = await request.json();

      if (!provider || !action) {
        return NextResponse.json({ message: 'provider and action are required' }, { status: 400 });
      }

      const nangoConnId = `${orgId}_${provider}`;

      if (action === 'connect') {
        await client.query(
          `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, connected_at)
           VALUES ($1, $2, 'connected', $3, NOW())
           ON CONFLICT (org_id, channel_type)
           DO UPDATE SET status = 'connected', nango_connection_id = $3, connected_at = NOW()`,
          [orgId, provider, nangoConnId]
        );

        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
           VALUES ($1, $2, 'connect', 'success', 200, $3, $4)`,
          [orgId, provider, `${provider} connected via Nango OAuth`, JSON.stringify({ connectionId: nangoConnId })]
        );

        return NextResponse.json({
          success: true,
          message: `${provider} connected successfully`,
          connectionId: nangoConnId,
        });
      }

      if (action === 'disconnect') {
        await client.query(
          `UPDATE channels SET status = 'disconnected', nango_connection_id = NULL WHERE org_id = $1 AND channel_type = $2`,
          [orgId, provider]
        );

        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
           VALUES ($1, $2, 'disconnect', 'success', 200, $3)`,
          [orgId, provider, `${provider} disconnected`]
        );

        return NextResponse.json({ success: true, message: `${provider} disconnected` });
      }

      return NextResponse.json({ message: 'Invalid action. Use "connect" or "disconnect".' }, { status: 400 });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Integration POST error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
