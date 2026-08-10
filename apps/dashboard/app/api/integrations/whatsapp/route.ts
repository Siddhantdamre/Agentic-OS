import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { accessToken, phoneNumberId, wabaId } = await request.json();

      if (!accessToken || !phoneNumberId) {
        return NextResponse.json({ message: 'Access Token and Phone Number ID are required' }, { status: 400 });
      }

      // Store manual credentials in the dedicated meta JSONB column (org-isolated by RLS).
      // Both camelCase (tool-executor reads meta.accessToken/meta.phoneNumberId) and
      // snake_case (webhook route reads meta->>'phone_number_id' / 'meta_access_token') keys
      // are persisted so every consumer resolves the same channel. nango_connection_id is
      // reserved for actual Nango connection IDs and stays NULL here.
      const metaPayload = JSON.stringify({
        accessToken,
        phoneNumberId,
        wabaId,
        phone_number_id: phoneNumberId,
        whatsapp_business_account_id: wabaId,
        meta_access_token: accessToken,
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
        message: `WhatsApp connected successfully`,
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
