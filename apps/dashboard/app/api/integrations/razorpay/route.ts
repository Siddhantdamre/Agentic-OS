/**
 * Per-org Razorpay API-key connect (not Nango OAuth).
 * Callers: apps/dashboard/lib/nango-client.ts connectRazorpayByok,
 * connectors + integrations UI modals.
 * Glob of app/api/integrations has whatsapp but no razorpay route (confirmed).
 * Writes channels.meta JSONB: { keyId, keySecret, key_id, key_secret, secret_hint }. The secret is
 * sealed (CHANNEL_SECRETS_KEY) and never returned to the client.
 */

import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { auditConnectorChange, denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { upsertOrgConnector } from '@/lib/connector-registry';
import { pingRazorpay } from '@darex/connectors';
import { sealSecret, secretHint, secretsKeyConfigured } from '@darex/whatsapp-gateway';

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const body = await request.json();
      const keyId = body.keyId || body.key_id;
      const keySecret = body.keySecret || body.key_secret;

      if (!keyId || !keySecret) {
        return NextResponse.json({ message: 'Razorpay keyId and keySecret are required' }, { status: 400 });
      }

      // The secret is stored encrypted; refuse to save one we could not protect.
      if (!secretsKeyConfigured()) {
        return NextResponse.json(
          { success: false, connected: false, message: 'Key storage is not set up on this server (CHANNEL_SECRETS_KEY).' },
          { status: 503 }
        );
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

      // Both legacy key names hold the same sealed value; secret_hint is safe to show.
      const sealed = sealSecret(keySecret);
      const metaPayload = JSON.stringify({
        keyId,
        keySecret: sealed,
        key_id: keyId,
        key_secret: sealed,
        secret_hint: secretHint(keySecret),
        verifiedAt: new Date().toISOString(),
      });

      await client.query(
        `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
         VALUES ($1, 'razorpay', 'connected', $2::jsonb, NOW())
         ON CONFLICT (org_id, channel_type, account_key)
         DO UPDATE SET status = 'connected',
           meta = COALESCE(channels.meta, '{}'::jsonb) || $2::jsonb,
           connected_at = NOW()`,
        [orgId, metaPayload]
      );

      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
         VALUES ($1, 'razorpay', 'connect', 'success', 200, $2)`,
        [orgId, 'Razorpay API keys verified and stored for this org']
      );

      await upsertOrgConnector(client, orgId, 'razorpay', {
        status: 'connected',
        nangoConnectionId: null,
        scopes: ['invoices.write', 'payments.read'],
        lastOkAt: new Date(),
        lastError: null,
      });

      await auditConnectorChange(client, {
        orgId,
        kind: 'connector.connect',
        actor: { actorType: 'user', userId },
        tool: 'razorpay',
        action: 'connect_byok',
        resultStatus: 'ok',
        payload: { accountId: 'primary', authMode: 'byok' },
      });

      realtimeHub.publish(orgId, { type: 'integration_updated', message: 'razorpay' });
      return NextResponse.json({
        success: true,
        connected: true,
        message: 'Razorpay keys verified and stored for this org. Agent tools use these per-org keys.',
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
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
      return NextResponse.json({
        connected: hasKeys,
        hasPerOrgKeys: hasKeys,
        hasEnvKeys: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
        connectedAt: row?.connected_at || null,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
