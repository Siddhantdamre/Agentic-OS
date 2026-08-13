/**
 * Per-org Razorpay API-key connect (not Nango OAuth).
 * Callers: apps/dashboard/lib/nango-client.ts connectRazorpayByok,
 * connectors + integrations UI modals.
 * Glob of app/api/integrations has whatsapp but no razorpay route (confirmed).
 * Writes channels.meta JSONB: { keyId, keySecret, key_id, key_secret } — never returned to the client.
 */

import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { pingRazorpay } from '@darex/connectors';

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = await request.json();
      const keyId = body.keyId || body.key_id;
      const keySecret = body.keySecret || body.key_secret;

      if (!keyId || !keySecret) {
        return NextResponse.json({ message: 'Razorpay keyId and keySecret are required' }, { status: 400 });
      }

      const ping = await pingRazorpay({ keyId, keySecret });
      if (!ping.ok) {
        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
           VALUES ($1, 'razorpay', 'connect', 'error', $2, $3)`,
          [orgId, ping.status, ping.message]
        );
        return NextResponse.json(
          { success: false, connected: false, message: ping.message, setupUrl: '/connectors' },
          { status: 400 }
        );
      }

      const metaPayload = JSON.stringify({
        keyId,
        keySecret,
        key_id: keyId,
        key_secret: keySecret,
        verifiedAt: new Date().toISOString(),
      });

      await client.query(
        `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
         VALUES ($1, 'razorpay', 'connected', $2::jsonb, NOW())
         ON CONFLICT (org_id, channel_type)
         DO UPDATE SET status = 'connected', meta = $2::jsonb, connected_at = NOW()`,
        [orgId, metaPayload]
      );

      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
         VALUES ($1, 'razorpay', 'connect', 'success', 200, $2)`,
        [orgId, 'Razorpay API keys verified and stored for this org']
      );

      return NextResponse.json({
        success: true,
        connected: true,
        message:
          'Razorpay keys verified. Connector test uses these keys. Agent Razorpay tools still read RAZORPAY_KEY_ID/SECRET env.',
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Razorpay connect error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT status, meta, connected_at FROM channels WHERE org_id = $1 AND channel_type = 'razorpay'`,
        [orgId]
      );
      const row = res.rows[0];
      const meta = row?.meta || {};
      const hasKeys = Boolean((meta.keyId || meta.key_id) && (meta.keySecret || meta.key_secret));
      const envFallback = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
      return NextResponse.json({
        connected: hasKeys || envFallback,
        hasPerOrgKeys: hasKeys,
        hasEnvKeys: envFallback,
        connectedAt: row?.connected_at || null,
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
