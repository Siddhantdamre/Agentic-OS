import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const payload = await request.json().catch(() => ({}));
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);

      const provider = payload.provider || payload.type || 'nango';
      const eventType = payload.event || 'webhook_received';
      const message = `Inbound webhook received from ${provider}: ${eventType}`;

      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
         VALUES ($1, $2, 'webhook', 'success', 200, $3, $4)`,
        [orgId, provider, message, JSON.stringify(payload)]
      );

      return NextResponse.json({ success: true, message: 'Webhook logged successfully' });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Webhook Endpoint Error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
