import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { NangoConnectorClient, pingNangoProvider } from '@darex/connectors';
import { isIntegrationId } from '@/lib/integrations-catalog';

export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/[provider]/ping
 * Live diagnostic ping; updates org_connectors health fields when migration 093 is applied.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ provider: string }> | { provider: string } }
) {
  try {
    const rawParams = await Promise.resolve(context.params);
    const provider = String(rawParams.provider || '').trim();
    if (!provider || !isIntegrationId(provider)) {
      return NextResponse.json({ error: `Unknown provider: ${provider || '(missing)'}` }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    const started = Date.now();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const nango = new NangoConnectorClient();
      const result = await pingNangoProvider(nango, orgId, provider);
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
