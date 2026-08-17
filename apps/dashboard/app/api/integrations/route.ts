import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { getConnectorDef, listConnectorDefs, listOrgConnectors, upsertOrgConnector } from '@/lib/connector-registry';
import { isPublicMetaKey, nangoUiUrl } from '@/lib/integrations-catalog';
import {
  deleteNangoConnection,
  isNangoSecretConfigured,
  listNangoConfigs,
  listNangoConnections,
  nangoConnectionExists,
  primaryConnectionId,
} from '@/lib/nango-server';

function publicMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const src = meta && typeof meta === 'object' ? meta : {};
  const out: Record<string, unknown> = {};
  if (src.shopDomain) out.shopDomain = src.shopDomain;
  if (src.subdomain) out.subdomain = src.subdomain;
  if (src.adAccountId) out.adAccountId = src.adAccountId;
  if (src.customerId) out.customerId = src.customerId;
  if (src.phoneNumberId || src.phone_number_id) out.phoneNumberId = src.phoneNumberId || src.phone_number_id;
  if (src.wabaId || src.whatsapp_business_account_id) {
    out.wabaId = src.wabaId || src.whatsapp_business_account_id;
  }
  out.hasAccessToken = Boolean(src.accessToken || src.meta_access_token);
  out.hasApiKey = Boolean(src.keyId || src.key_id);
  return out;
}

function whatsappByokConnected(meta: Record<string, unknown> | null | undefined): boolean {
  const src = meta && typeof meta === 'object' ? meta : {};
  const token = src.accessToken || src.meta_access_token;
  const phone = src.phoneNumberId || src.phone_number_id;
  return Boolean(token && phone);
}

// ── GET: Ultra-fast batch fetch of integrations for current orgId ─────────────
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      // Fetch channels from DB strictly for current org_id
      const channelsRes = await client.query(
        `SELECT channel_type, status, nango_connection_id, connected_at, meta FROM channels WHERE org_id = $1`,
        [orgId]
      );
      const dbChannelsMap = new Map(channelsRes.rows.map((r: any) => [r.channel_type, r]));

      const [defs, orgConnectors] = await Promise.all([
        listConnectorDefs(client),
        listOrgConnectors(client, orgId),
      ]);

      const nangoSecretOk = isNangoSecretConfigured();
      const [nangoConns, nangoConfigs] = await Promise.all([
        listNangoConnections(orgId),
        listNangoConfigs(),
      ]);
      const nangoConnectedIds = new Set(
        nangoConns.map((c) => c.catalogId).filter((id): id is string => Boolean(id))
      );
      const nangoListUsable = nangoConns.some((c) => Boolean(c.catalogId));
      const configByKey = new Map(nangoConfigs.map((c) => [c.uniqueKey, c]));

      // Connected badge is Nango (or verified BYOK) only — never org_connectors.status.
      const integrations = await Promise.all(
        defs.map(async (item) => {
          const dbRecord = dbChannelsMap.get(item.id) as any;
          const orgConn = orgConnectors.get(item.id);
          const meta = publicMeta(dbRecord?.meta);

          let oauthConfigured = item.authMode !== 'oauth';
          let missingConfigReason: string | undefined = item.operatorHint;
          if (item.authMode === 'oauth') {
            const keys = item.id === 'whatsapp' ? ['whatsapp', 'whatsapp-business'] : [item.id];
            const match = keys.map((k) => configByKey.get(k)).find(Boolean);
            if (match) {
              oauthConfigured = match.configured;
              missingConfigReason = match.reason || item.operatorHint;
            } else if (nangoConfigs.length === 0 && nangoSecretOk) {
              oauthConfigured = false;
              missingConfigReason = `No Nango integration named ${item.id}. Create it in ${nangoUiUrl()} and paste a real OAuth client ID.`;
            } else if (!nangoSecretOk) {
              oauthConfigured = false;
              missingConfigReason = 'NANGO_SECRET_KEY is not set on the dashboard — cannot verify Nango configs.';
            } else {
              oauthConfigured = false;
              missingConfigReason =
                `No Nango integration named ${item.id}. Create it in ${nangoUiUrl()} and paste a real OAuth client ID.`;
            }
          }

          let isConnected = false;
          let connectionSource: 'nango' | 'byok' | 'env' | null = null;

          if (item.authMode === 'oauth') {
            if (nangoConnectedIds.has(item.id)) {
              isConnected = true;
              connectionSource = 'nango';
            } else if (!nangoListUsable) {
              const exists = await nangoConnectionExists(orgId, item.id);
              isConnected = exists;
              connectionSource = exists ? 'nango' : null;
            }
          } else if (item.id === 'whatsapp') {
            const byok = whatsappByokConnected(dbRecord?.meta);
            const nangoWa = nangoConnectedIds.has('whatsapp') || (await nangoConnectionExists(orgId, 'whatsapp'));
            isConnected = byok || nangoWa;
            connectionSource = byok ? 'byok' : nangoWa ? 'nango' : null;
          } else if (item.id === 'razorpay') {
            const perOrg = Boolean(
              dbRecord?.meta && (dbRecord.meta.keyId || dbRecord.meta.key_id) && (dbRecord.meta.keySecret || dbRecord.meta.key_secret)
            );
            const envKeys = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
            isConnected = perOrg || envKeys;
            connectionSource = perOrg ? 'byok' : envKeys ? 'env' : null;
          }

          return {
            ...item,
            connected: Boolean(isConnected),
            status: isConnected ? 'Connected' : 'Disconnected',
            nangoConnectionId:
              dbRecord?.nango_connection_id ||
              (isConnected && connectionSource === 'nango' ? `${orgId}_${item.id}` : null) ||
              (isConnected ? orgConn?.nangoConnectionId : null),
            lastSyncedAt: dbRecord?.connected_at || (isConnected ? orgConn?.lastOkAt : null) || null,
            oauthConfigured,
            missingConfigReason: isConnected ? undefined : missingConfigReason,
            connectionSource,
            meta,
            nangoUiUrl: nangoUiUrl(),
          };
        })
      );

      // Fetch stats & logs
      const todayLogsRes = await client.query(
        `SELECT status, count(*) as count FROM channel_logs WHERE org_id = $1 AND created_at >= CURRENT_DATE GROUP BY status`,
        [orgId]
      );

      let totalSyncsToday = 0;
      let failedWebhooks = 0;
      todayLogsRes.rows.forEach((row: any) => {
        const count = parseInt(row.count, 10);
        totalSyncsToday += count;
        if (row.status === 'error' || row.status === 'failed') {
          failedWebhooks += count;
        }
      });

      const connectedCount = integrations.filter((i) => i.connected).length;
      const apiQuotaPct = Math.min(100, parseFloat(((totalSyncsToday / 1000) * 100).toFixed(1)));

      const logsRes = await client.query(
        `SELECT channel_type, event_type, status, status_code, message, created_at
         FROM channel_logs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [orgId]
      );

      return NextResponse.json({
        integrations,
        stats: {
          connectedApps: connectedCount,
          totalSyncsToday,
          failedWebhooks,
          apiQuotaUsed: `${apiQuotaPct}%`,
        },
        logs: logsRes.rows,
        nango: {
          secretConfigured: nangoSecretOk,
          uiUrl: nangoUiUrl(),
        },
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Integrations GET error:', err);
    return NextResponse.json({ message: err.message, integrations: [], stats: {}, logs: [] }, { status: 500 });
  }
}

// ── POST: Connect or Disconnect an integration for current orgId ──────────────
export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { provider, action, extra } = await request.json();

      if (!provider || !action) {
        return NextResponse.json({ message: 'provider and action are required' }, { status: 400 });
      }

      const spec = await getConnectorDef(client, provider);
      if (!spec) {
        return NextResponse.json({ message: `Unknown provider: ${provider}` }, { status: 400 });
      }

      const nangoConnId = primaryConnectionId(orgId, provider);

      if (action === 'connect') {
        if (!spec || spec.authMode !== 'oauth') {
          return NextResponse.json(
            {
              success: false,
              message:
                spec?.authMode === 'byok'
                  ? `Use POST /api/integrations/whatsapp for WhatsApp BYOK.`
                  : spec?.authMode === 'api_key'
                    ? `Use POST /api/integrations/razorpay for Razorpay API keys.`
                    : `${provider} cannot be connected via Nango OAuth.`,
            },
            { status: 400 }
          );
        }

        const realConnection = await nangoConnectionExists(orgId, provider);
        if (!realConnection) {
          return NextResponse.json(
            {
              success: false,
              message: `No real Nango OAuth connection found for ${provider}. Complete the OAuth popup first — the connection was not persisted.`,
              setupUrl: '/connectors',
              nangoUiUrl: nangoUiUrl(),
            },
            { status: 400 }
          );
        }

        const extraMeta =
          extra && typeof extra === 'object'
            ? Object.fromEntries(
                Object.entries(extra).filter(([k, v]) => isPublicMetaKey(k) && v != null && String(v).length > 0)
              )
            : {};

        await client.query(
          `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, connected_at, meta)
           VALUES ($1, $2, 'connected', $3, NOW(), $4::jsonb)
           ON CONFLICT (org_id, channel_type)
           DO UPDATE SET status = 'connected', nango_connection_id = $3, connected_at = NOW(),
             meta = COALESCE(channels.meta, '{}'::jsonb) || $4::jsonb`,
          [orgId, provider, nangoConnId, JSON.stringify(extraMeta)]
        );

        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
           VALUES ($1, $2, 'connect', 'success', 200, $3, $4)`,
          [orgId, provider, `${provider} connected via Nango OAuth`, JSON.stringify({ connectionId: nangoConnId })]
        );

        await upsertOrgConnector(client, orgId, provider, {
          status: 'connected',
          nangoConnectionId: nangoConnId,
          scopes: spec.scopes,
          lastOkAt: new Date(),
          lastError: null,
        });

        return NextResponse.json({
          success: true,
          message: `${provider} connected successfully`,
          connectionId: nangoConnId,
        });
      }

      if (action === 'disconnect') {
        await deleteNangoConnection(orgId, provider);

        await client.query(
          `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, meta, connected_at)
           VALUES ($1, $2, 'disconnected', NULL, '{}'::jsonb, NULL)
           ON CONFLICT (org_id, channel_type)
           DO UPDATE SET status = 'disconnected', nango_connection_id = NULL, meta = '{}'::jsonb, connected_at = NULL`,
          [orgId, provider]
        );

        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
           VALUES ($1, $2, 'disconnect', 'success', 200, $3)`,
          [orgId, provider, `${provider} disconnected (Nango connection deleted)`]
        );

        await upsertOrgConnector(client, orgId, provider, {
          status: 'disconnected',
          nangoConnectionId: null,
          scopes: [],
          lastOkAt: null,
          lastError: null,
        });

        return NextResponse.json({ success: true, message: `${provider} disconnected` });
      }

      if (action === 'update_config') {
        const extraMeta =
          extra && typeof extra === 'object'
            ? Object.fromEntries(
                Object.entries(extra).filter(([k, v]) => isPublicMetaKey(k) && v != null && String(v).length > 0)
              )
            : {};
        await client.query(
          `INSERT INTO channels (org_id, channel_type, status, meta)
           VALUES ($1, $2, 'disconnected', $3::jsonb)
           ON CONFLICT (org_id, channel_type)
           DO UPDATE SET meta = COALESCE(channels.meta, '{}'::jsonb) || $3::jsonb`,
          [orgId, provider, JSON.stringify(extraMeta)]
        );
        return NextResponse.json({ success: true, message: `${provider} config saved` });
      }

      return NextResponse.json({ message: 'Invalid action. Use "connect", "disconnect", or "update_config".' }, { status: 400 });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Integration POST error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
