import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { pingWhatsApp } from '@darex/connectors';

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { accessToken, phoneNumberId, wabaId } = await request.json();

      if (!accessToken || !phoneNumberId) {
        return NextResponse.json({ message: 'Access Token and Phone Number ID are required' }, { status: 400 });
      }

      const ping = await pingWhatsApp({ accessToken, phoneNumberId });
      if (!ping.ok) {
        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
           VALUES ($1, 'whatsapp', 'connect', 'error', $2, $3, $4)`,
          [orgId, ping.status, ping.message, JSON.stringify({ phoneNumberId })]
        );
        return NextResponse.json(
          {
            success: false,
            connected: false,
            message: ping.message,
            setupUrl: '/connectors',
          },
          { status: ping.status === 401 || ping.status === 400 ? 400 : 502 }
        );
      }

      const metaPayload = JSON.stringify({
        accessToken,
        phoneNumberId,
        wabaId,
        phone_number_id: phoneNumberId,
        whatsapp_business_account_id: wabaId,
        meta_access_token: accessToken,
        verifiedAt: new Date().toISOString(),
      });

      await client.query(
        `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
         VALUES ($1, 'whatsapp', 'connected', $2::jsonb, NOW())
         ON CONFLICT (org_id, channel_type)
         DO UPDATE SET status = 'connected', meta = $2::jsonb, connected_at = NOW()`,
        [orgId, metaPayload]
      );

      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
         VALUES ($1, 'whatsapp', 'connect', 'success', 200, $2, $3)`,
        [orgId, `WhatsApp manually connected via System User Token`, JSON.stringify({ phoneNumberId })]
      );

      return NextResponse.json({
        success: true,
        connected: true,
        message: 'WhatsApp connected successfully',
        phone: ping.data,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('WhatsApp Manual Connect Error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT status, meta, connected_at FROM channels WHERE org_id = $1 AND channel_type = 'whatsapp'`,
        [orgId]
      );
      const row = res.rows[0];
      const meta = row?.meta || {};
      const hasToken = Boolean(meta.accessToken || meta.meta_access_token);
      const phoneNumberId = meta.phoneNumberId || meta.phone_number_id || null;
      return NextResponse.json({
        connected: Boolean(hasToken && phoneNumberId && (row?.status === 'connected' || row?.status === 'active')),
        phoneNumberId,
        wabaId: meta.wabaId || meta.whatsapp_business_account_id || null,
        connectedAt: row?.connected_at || null,
        hasToken,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
