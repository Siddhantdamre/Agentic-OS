import { NextResponse } from 'next/server';
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const ALL_INTEGRATIONS = [
  { id: 'whatsapp', name: 'WhatsApp Business', category: 'Messaging', icon: 'MessageSquare', desc: 'Meta Cloud API for inbound & outbound customer chats' },
  { id: 'gmail', name: 'Gmail / Email', category: 'Email', icon: 'Mail', desc: 'Inbound email triage & outbound response drafting' },
  { id: 'google-calendar', name: 'Google Calendar', category: 'Calendar', icon: 'Calendar', desc: 'Real-time slot checking & appointment booking' },
  { id: 'hubspot', name: 'HubSpot CRM', category: 'CRM', icon: 'Database', desc: 'Automatic contact creation & deal stage updates' },
  { id: 'razorpay', name: 'Razorpay / Payments', category: 'Payments', icon: 'CreditCard', desc: 'Instant payment links & invoice status queries' },
  { id: 'meta-ads', name: 'Meta Ads', category: 'Ads', icon: 'Megaphone', desc: 'ROAS tracking & ad campaign monitoring' },
  { id: 'google-ads', name: 'Google Ads', category: 'Ads', icon: 'BarChart2', desc: 'Search campaign analytics & conversion logging' },
];

async function ensureOrgExists(client: any): Promise<string> {
  const orgRes = await client.query(`SELECT id FROM orgs LIMIT 1`);
  if (orgRes.rows.length > 0 && orgRes.rows[0].id) {
    return orgRes.rows[0].id;
  }

  const newOrg = await client.query(
    `INSERT INTO orgs (name, slug, plan, status) VALUES ('DareX Demo Org', 'darex-demo-org', 'pro', 'active') RETURNING id`
  );
  return newOrg.rows[0].id;
}

export async function GET(request: Request) {
  const client = await pool.connect();
  try {
    const orgId = await ensureOrgExists(client);
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

    const res = await client.query(`SELECT channel_type, status, nango_connection_id, connected_at, meta FROM channels WHERE org_id = $1`, [orgId]);
    const dbChannelsMap = new Map(res.rows.map((r) => [r.channel_type, r]));

    const integrations = ALL_INTEGRATIONS.map((item) => {
      const dbRecord = dbChannelsMap.get(item.id);
      const connected = dbRecord ? dbRecord.status === 'active' || dbRecord.status === 'connected' : false;
      return {
        ...item,
        connected,
        status: connected ? 'Connected' : 'Disconnected',
        nangoConnectionId: dbRecord?.nango_connection_id || null,
        lastSyncedAt: dbRecord?.connected_at || null,
      };
    });

    return NextResponse.json({
      integrations,
      stats: {
        connectedApps: integrations.filter((i) => i.connected).length,
        totalSyncsToday: 1420,
        failedWebhooks: 0,
        apiQuotaUsed: '12.4%',
      },
    });
  } catch (err: any) {
    console.error('Integrations GET error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function POST(request: Request) {
  const client = await pool.connect();
  try {
    const { provider, action } = await request.json();

    const orgId = await ensureOrgExists(client);
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

    if (action === 'connect') {
      const nangoConnId = `darex_dev_${provider}_${Date.now()}`;
      await client.query(
        `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, connected_at)
         VALUES ($1, $2, 'connected', $3, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [orgId, provider, nangoConnId]
      );
      await client.query(
        `UPDATE channels SET status = 'connected', connected_at = NOW() WHERE org_id = $1 AND channel_type = $2`,
        [orgId, provider]
      );
      return NextResponse.json({ success: true, message: `${provider} connected successfully` });
    }

    if (action === 'disconnect') {
      await client.query(
        `UPDATE channels SET status = 'disconnected' WHERE org_id = $1 AND channel_type = $2`,
        [orgId, provider]
      );
      return NextResponse.json({ success: true, message: `${provider} disconnected` });
    }

    return NextResponse.json({ message: 'Invalid action' }, { status: 400 });
  } catch (err: any) {
    console.error('Integration POST error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  } finally {
    client.release();
  }
}
