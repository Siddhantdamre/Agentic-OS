import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { ConnectionPingResult, NangoConnectorClient, pingNangoProvider, pingRazorpay, pingWhatsApp } from '@darex/connectors';
import { getEvolutionState, openSecret, providerIdOf } from '@darex/whatsapp-gateway';
import { isIntegrationId } from '@/lib/integrations-catalog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/[provider]/ping
 * Live diagnostic ping; updates org_connectors health fields when migration 093 is applied.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ provider: string }> }
) {
  try {
    const rawParams = await context.params;
    const provider = String(rawParams.provider || '').trim();
    if (!provider || !isIntegrationId(provider)) {
      return NextResponse.json({ error: `Unknown provider: ${provider || '(missing)'}` }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    const started = Date.now();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;

      let result: ConnectionPingResult;

      if (provider === 'whatsapp') {
        const channelRes = await client.query(
          `SELECT status, meta FROM channels WHERE org_id = $1 AND channel_type = 'whatsapp' AND account_key = ''`,
          [orgId]
        );
        const channel = channelRes.rows[0] as { status?: string; meta?: Record<string, unknown> } | undefined;
        if (!channel || (channel.status !== 'connected' && channel.status !== 'active')) {
          result = {
            provider: 'whatsapp',
            ok: false,
            connected: false,
            status: 404,
            message: 'WhatsApp is not connected for this organization. Add an access token and phone number ID.',
            reconnectUrl: '/integrations',
          };
        } else if (providerIdOf(channel.meta) === 'evolution') {
          const instance = String(channel.meta?.evolution_instance || '');
          const live = await getEvolutionState(instance);
          const ok = live.state === 'open';
          result = {
            provider: 'whatsapp',
            ok,
            connected: ok,
            status: ok ? 200 : 503,
            message: ok ? 'WhatsApp Web (QR) session is connected' : `WhatsApp Web state: ${live.state}`,
            data: { provider: 'evolution', state: live.state },
            reconnectUrl: ok ? undefined : '/integrations',
          };
        } else {
          // Meta Cloud API
          const meta = channel.meta || {};
          let accessToken = String(meta.accessToken || meta.meta_access_token || '');
          try {
            accessToken = accessToken ? openSecret(accessToken) : '';
          } catch {
            accessToken = '';
          }
          const phoneNumberId = String(meta.phoneNumberId || meta.phone_number_id || '');
          if (!accessToken || !phoneNumberId) {
            result = {
              provider: 'whatsapp',
              ok: false,
              connected: false,
              status: 400,
              message: 'WhatsApp access token or phone number ID is missing or cannot be opened.',
              reconnectUrl: '/integrations',
            };
          } else {
            result = await pingWhatsApp({ accessToken, phoneNumberId });
          }
        }
      } else if (provider === 'razorpay') {
        const channelRes = await client.query(
          `SELECT status, meta FROM channels WHERE org_id = $1 AND channel_type = 'razorpay' AND account_key = ''`,
          [orgId]
        );
        const channel = channelRes.rows[0] as { status?: string; meta?: Record<string, unknown> } | undefined;
        const meta = channel?.meta || {};
        const keyId = String(meta.keyId || meta.key_id || process.env.RAZORPAY_KEY_ID || '');
        const keySecret = String(meta.keySecret || meta.key_secret || process.env.RAZORPAY_KEY_SECRET || '');
        if (!keyId || !keySecret) {
          result = {
            provider: 'razorpay',
            ok: false,
            connected: false,
            status: 404,
            message: 'Razorpay keys are not configured for this organization.',
            reconnectUrl: '/integrations',
          };
        } else {
          result = await pingRazorpay({ keyId, keySecret });
        }
      } else {
        const nango = new NangoConnectorClient();
        result = await pingNangoProvider(nango, orgId, provider);
      }

      const latencyMs = Date.now() - started;
      const health = result.ok ? 'healthy' : result.status === 401 || result.status === 403 ? 'revoked' : 'degraded';

      try {
        await client.query(
          `UPDATE org_connectors
              SET health_status = $1,
                  last_health_check_at = NOW(),
                  last_ping_latency_ms = $2,
                  last_error_message = $3,
                  last_ok_at = CASE WHEN $4::boolean THEN NOW() ELSE last_ok_at END,
                  last_error = $3,
                  updated_at = NOW()
            WHERE org_id = $5 AND connector_key = $6 AND account_id = 'primary'`,
          [health, latencyMs, result.ok ? null : result.message, result.ok, orgId, provider]
        );
      } catch (err) {
        // Pre-093 schema: health columns may be missing — ping result still returned honestly.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/account_id|health_status|does not exist|column/i.test(msg)) throw err;
      }

      return NextResponse.json({
        provider,
        success: result.ok,
        connected: result.connected,
        latencyMs,
        health,
        message: result.message,
        reconnectUrl: result.ok ? undefined : result.reconnectUrl || '/connectors',
        setupUrl: result.ok ? undefined : result.reconnectUrl || '/connectors',
        data: result.data,
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    return NextResponse.json(
      {
        success: false,
        connected: false,
        error: err?.message || 'Ping failed',
        reconnectUrl: '/connectors',
      },
      { status: 502 }
    );
  }
}
