import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { browserReachableOrigin, getIntegration, isIntegrationId, isPublicMetaKey, nangoUiUrl } from '@/lib/integrations-catalog';
import { nangoKeysFor } from '@darex/connectors';
import {
  getNangoConfigStatus,
  getNangoServerConfig,
  nangoConnectionExists,
  primaryConnectionId,
} from '@/lib/nango-server';

/**
 * GET /api/integrations/nango-token
 * Returns Nango public key and scoped connection metadata for the authenticated user's org
 */
export async function GET(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    client.release();

    const url = new URL(request.url);
    const provider = url.searchParams.get('provider') || '';
    if (!provider || !isIntegrationId(provider)) {
      return NextResponse.json({ error: 'A valid provider query param is required' }, { status: 400 });
    }

    const spec = getIntegration(provider);
    const { publicKey, host } = getNangoServerConfig();
    // The browser dials this host in the OAuth popup, so it must be an address
    // the browser can resolve — never the compose service name this container uses.
    const nangoHost = browserReachableOrigin(process.env.NEXT_PUBLIC_NANGO_HOST || host);
    const connectionId = primaryConnectionId(orgId, provider);
    const keys = nangoKeysFor(provider);
    const config = spec?.authMode === 'oauth' ? await getNangoConfigStatus(provider) : null;
    const googleAuth = provider.startsWith('google') || provider === 'gmail';

    return NextResponse.json({
      nangoPublicKey: publicKey,
      nangoHost,
      connectionId,
      provider,
      providerConfigKey: config?.uniqueKey || keys[0] || provider,
      authMode: spec?.authMode || 'oauth',
      extraConnectFields: spec?.extraConnectFields || [],
      oauthConfigured: spec?.authMode !== 'oauth' ? true : Boolean(config?.configured),
      missingConfigReason: spec?.authMode === 'oauth' ? config?.reason || spec?.operatorHint : spec?.operatorHint,
      nangoUiUrl: nangoUiUrl(),
      authorizationParams: googleAuth
        ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }
        : undefined,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Nango token GET error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/integrations/nango-token
 * Called after Nango OAuth popup completes to confirm connection in PostgreSQL database
 */
export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { provider, connectionId, success, extra } = await request.json();

      if (!provider) {
        return NextResponse.json({ error: 'provider is required' }, { status: 400 });
      }
      if (!isIntegrationId(provider)) {
        return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
      }

      const spec = getIntegration(provider);
      if (spec && spec.authMode !== 'oauth') {
        return NextResponse.json(
          {
            success: false,
            error: `${provider} is not Nango OAuth (${spec.authMode})`,
          },
          { status: 400 }
        );
      }

      const nangoConnId = connectionId || primaryConnectionId(orgId, provider);

      const real = success && (await nangoConnectionExists(orgId, provider));
      const status = real ? 'connected' : 'failed';
      const effectiveSuccess = status === 'connected';

      const extraMeta =
        extra && typeof extra === 'object'
          ? Object.fromEntries(
              Object.entries(extra).filter(([k, v]) => isPublicMetaKey(k) && v != null && String(v).length > 0)
            )
          : {};

      await client.query(
        `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, connected_at, meta)
         VALUES ($1, $2, $3, $4, NOW(), $5::jsonb)
         ON CONFLICT (org_id, channel_type)
         DO UPDATE SET status = $3, nango_connection_id = $4, connected_at = NOW(),
           meta = COALESCE(channels.meta, '{}'::jsonb) || $5::jsonb`,
        [orgId, provider, status, nangoConnId, JSON.stringify(extraMeta)]
      );

      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
         VALUES ($1, $2, 'nango_oauth', $3, $4, $5, $6)`,
        [
          orgId,
          provider,
          effectiveSuccess ? 'success' : 'error',
          effectiveSuccess ? 200 : 400,
          `Nango OAuth ${effectiveSuccess ? 'completed' : 'not confirmed'} for ${provider}`,
          JSON.stringify({ connectionId: nangoConnId, provider }),
        ]
      );

      return NextResponse.json({
        success: effectiveSuccess,
        connectionId: nangoConnId,
        message: effectiveSuccess
          ? `${provider} connected via Nango`
          : `connection not confirmed (no real Nango OAuth connection found for ${provider})`,
        nangoUiUrl: nangoUiUrl(),
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Nango token confirm error:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
