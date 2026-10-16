import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { tryReadJson } from '@/lib/safe-json';
import { getIntegration, isIntegrationId, isPublicMetaKey, nangoUiUrl } from '@/lib/integrations-catalog';
import { upsertOrgConnector } from '@/lib/connector-registry';
import { connectionIdsFor, nangoKeysFor } from '@darex/connectors';
import {
  getNangoConfigStatus,
  getNangoServerConfig,
  nangoConnectionExists,
  primaryConnectionId,
} from '@/lib/nango-server';
import { publicErrorMessage } from '@/lib/public-error';

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
    const { publicKey } = getNangoServerConfig();
    // Browser-reachable host for the Nango popup SDK — never container DNS.
    // nangoUiUrl() prefers NEXT_PUBLIC_NANGO_HOST, then NANGO_SERVER_URL.
    const nangoHost = nangoUiUrl();
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
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
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
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      const { provider: rawProvider, connectionId, success, extra } = body as {
        provider?: unknown; connectionId?: unknown; success?: unknown; extra?: unknown;
      };
      const provider = typeof rawProvider === 'string' ? rawProvider : '';

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

      const nangoConnId = typeof connectionId === 'string' && connectionId
        ? connectionId
        : primaryConnectionId(orgId, String(provider));

      // Never persist a client-supplied connectionId that doesn't belong to
      // this org — it could point at another tenant's Nango connection.
      const allowedIds = new Set(connectionIdsFor(orgId, String(provider)));
      if (!allowedIds.has(nangoConnId)) {
        return NextResponse.json(
          { error: 'connectionId does not belong to this organization' },
          { status: 400 }
        );
      }

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
         VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'connected' THEN NOW() ELSE NULL END, $5::jsonb)
         ON CONFLICT (org_id, channel_type, account_key)
         DO UPDATE SET status = $3,
           nango_connection_id = CASE WHEN $3 = 'connected' THEN $4 ELSE NULL END,
           connected_at = CASE WHEN $3 = 'connected' THEN NOW() ELSE NULL END,
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

      await upsertOrgConnector(client, orgId, provider, {
        status: effectiveSuccess ? 'connected' : 'error',
        nangoConnectionId: effectiveSuccess ? nangoConnId : null,
        scopes: spec?.scopes || [],
        lastOkAt: effectiveSuccess ? new Date() : null,
        lastError: effectiveSuccess ? null : 'Nango OAuth not confirmed',
      });

      if (effectiveSuccess && (provider === 'google-workspace' || provider === 'google' || provider === 'gmail' || provider.startsWith('google-'))) {
        const googleFamily = [
          'gmail',
          'google-calendar',
          'google-drive',
          'google-docs',
          'google-sheets',
          'google-slides',
          'google-workspace',
        ];
        for (const gProvider of googleFamily) {
          if (gProvider === provider) continue;
          const gSpec = getIntegration(gProvider);
          await client.query(
            `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, connected_at, meta)
             VALUES ($1, $2, 'connected', $3, NOW(), $4::jsonb)
             ON CONFLICT (org_id, channel_type, account_key)
             DO UPDATE SET status = 'connected',
               nango_connection_id = $3,
               connected_at = NOW(),
               meta = COALESCE(channels.meta, '{}'::jsonb) || $4::jsonb`,
            [orgId, gProvider, nangoConnId, JSON.stringify(extraMeta)]
          );
          await upsertOrgConnector(client, orgId, gProvider, {
            status: 'connected',
            nangoConnectionId: nangoConnId,
            scopes: gSpec?.scopes || [],
            lastOkAt: new Date(),
            lastError: null,
          });
        }
      }

      return NextResponse.json({
        success: effectiveSuccess,
        connected: effectiveSuccess,
        connectionId: nangoConnId,
        message: effectiveSuccess
          ? `${provider} connected via Nango`
          : `connection not confirmed (no real Nango OAuth connection found for ${provider})`,
        ...(effectiveSuccess
          ? {}
          : { reconnectUrl: '/connectors', setupUrl: '/connectors' }),
        nangoUiUrl: nangoUiUrl(),
      });
    } finally {
      client.release();
    }
  } catch (error: any) {
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('Nango token confirm error:', error);
    return NextResponse.json({ error: publicErrorMessage(error, 'Internal Server Error') }, { status: 500 });
  }
}
