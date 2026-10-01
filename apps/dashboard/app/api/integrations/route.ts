import { providerIdOf, stopEvolutionInstance } from '@darex/whatsapp-gateway';
import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime-hub';
import { recordAuditEvent } from '@/lib/audit-events';
import { auditConnectorChange, denyUnlessConnectorManager } from '@/lib/connector-rbac';
import { oauthChannelsToDemote } from '@/lib/channel-reconcile';
import { getConnectorDef, listConnectorDefs, listOrgConnectors, upsertOrgConnector } from '@/lib/connector-registry';
import { isPublicMetaKey, nangoUiUrl } from '@/lib/integrations-catalog';
import { listWhatsAppChannels, promoteWhatsAppPrimary, publicWhatsAppNumber } from '@/lib/whatsapp-numbers';
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
  if (src.provider === 'evolution') out.provider = 'evolution';
  // Safe-to-show identity of the connected WhatsApp (never the token itself).
  if (typeof src.token_hint === 'string') out.tokenHint = src.token_hint;
  const shownPhone = src.display_phone_number || src.linked_phone;
  if (typeof shownPhone === 'string' && shownPhone) out.phone = shownPhone;
  if (typeof src.verified_name === 'string' && src.verified_name) out.verifiedName = src.verified_name;
  else if (typeof src.profile_name === 'string' && src.profile_name) out.verifiedName = src.profile_name;
  out.hasAccessToken = Boolean(src.accessToken || src.meta_access_token);
  out.hasApiKey = Boolean(src.keyId || src.key_id);
  return out;
}

function whatsappByokConnected(
  meta: Record<string, unknown> | null | undefined,
  status?: string | null
): boolean {
  const src = meta && typeof meta === 'object' ? meta : {};
  // QR-linked (Evolution): connected once the phone finished pairing.
  if (providerIdOf(src) === 'evolution') {
    return Boolean(src.evolution_instance) && status === 'connected';
  }
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
        `SELECT channel_type, status, nango_connection_id, connected_at, meta FROM channels WHERE org_id = $1 AND account_key = ''`,
        [orgId]
      );
      const dbChannelsMap = new Map(channelsRes.rows.map((r: any) => [r.channel_type, r]));
      // Extra WhatsApp numbers hang off the WhatsApp card; the primary is the card itself.
      const whatsappNumbers = (await listWhatsAppChannels(client, orgId)).map(publicWhatsAppNumber);

      const [defs, orgConnectors] = await Promise.all([
        listConnectorDefs(client),
        listOrgConnectors(client, orgId),
      ]);

      const nangoSecretOk = isNangoSecretConfigured();
      const [nangoList, nangoConfigs] = await Promise.all([
        listNangoConnections(orgId),
        listNangoConfigs(),
      ]);
      const nangoConns = nangoList.connections;
      const nangoListOk = nangoList.ok;
      // When the list call failed because Nango rejected the key or is unreachable, a probe per
      // connector would fail the same way (and each can wait out the timeout), so skip them.
      const canProbeNango = !nangoListOk && nangoList.reason === 'error';
      const nangoConnectedIds = new Set(
        nangoConns.map((c) => c.catalogId).filter((id): id is string => Boolean(id))
      );
      const configByKey = new Map(nangoConfigs.map((c) => [c.uniqueKey, c]));

      // Keep channels.status aligned with live Nango so Ask-AI allowlists don't
      // keep tools for connections that Nango already revoked.
      const dbStatuses = new Map<string, string>(
        [...dbChannelsMap.entries()].map(([id, row]) => [id, String((row as { status?: string }).status || '')])
      );
      const staleOauth = oauthChannelsToDemote(defs, dbStatuses, nangoConnectedIds, nangoListOk);
      if (staleOauth.length > 0) {
        await client.query(
          `UPDATE channels
              SET status = 'disconnected', nango_connection_id = NULL, connected_at = NULL
            WHERE org_id = $1
              AND channel_type = ANY($2::text[])
              AND status IN ('connected', 'active')`,
          [orgId, staleOauth]
        );
        for (const key of staleOauth) {
          await upsertOrgConnector(client, orgId, key, {
            status: 'disconnected',
            nangoConnectionId: null,
            scopes: [],
            lastOkAt: null,
            lastError: 'Nango connection missing — demoted on connectors refresh',
          });
          const row = dbChannelsMap.get(key) as { status?: string; nango_connection_id?: string } | undefined;
          if (row) {
            row.status = 'disconnected';
            row.nango_connection_id = undefined;
          }
        }
      }

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
            } else if (canProbeNango) {
              const exists = await nangoConnectionExists(orgId, item.id);
              isConnected = exists;
              connectionSource = exists ? 'nango' : null;
            }
          } else if (item.id === 'whatsapp') {
            const byok = whatsappByokConnected(dbRecord?.meta, dbRecord?.status);
            const nangoWa =
              nangoConnectedIds.has('whatsapp') ||
              (canProbeNango && (await nangoConnectionExists(orgId, 'whatsapp')));
            isConnected = byok || nangoWa;
            connectionSource = byok ? 'byok' : nangoWa ? 'nango' : null;
          } else if (item.id === 'razorpay') {
            // Agent may fall back to env only with ALLOW_GLOBAL_RAZORPAY_DEV —
            // UI "connected" is per-org keys only so Disconnect actually clears it.
            const perOrg = Boolean(
              dbRecord?.meta &&
                (dbRecord.meta.keyId || dbRecord.meta.key_id) &&
                (dbRecord.meta.keySecret || dbRecord.meta.key_secret)
            );
            isConnected = perOrg;
            connectionSource = perOrg ? 'byok' : null;
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
            ...(item.id === 'whatsapp' ? { whatsappNumbers } : {}),
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
          publicKeyConfigured: Boolean(process.env.NEXT_PUBLIC_NANGO_PUBLIC_KEY),
          uiUrl: nangoUiUrl(),
        },
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('Integrations GET error:', err);
    return NextResponse.json({ message: err.message, integrations: [], stats: {}, logs: [] }, { status: 500 });
  }
}

// ── POST: Connect or Disconnect an integration for current orgId ──────────────
export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
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
              connected: false,
              message: `No real Nango OAuth connection found for ${provider}. Complete the OAuth popup first — the connection was not persisted.`,
              reconnectUrl: '/connectors',
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
           ON CONFLICT (org_id, channel_type, account_key)
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

        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'connector.connect',
              actor: { actorType: 'user', userId },
              tool: provider,
              action: 'connect',
              resultStatus: 'ok',
              riskClass: 'high',
              payload: { connectionId: nangoConnId, accountId: 'primary' },
            },
            { client, orgId }
          );
        } catch {
          // audit_events may be unavailable in partial migrations
        }

        realtimeHub.publish(orgId, { type: 'integration_updated', message: provider });
        return NextResponse.json({
          success: true,
          message: `${provider} connected successfully`,
          connectionId: nangoConnId,
        });
      }

      if (action === 'disconnect') {
        // OAuth: must revoke in Nango before clearing local state — otherwise tools
        // keep working via leftover Nango tokens while the UI shows Disconnected.
        if (spec.authMode === 'oauth') {
          if (!isNangoSecretConfigured()) {
            return NextResponse.json(
              {
                success: false,
                message:
                  'NANGO_SECRET_KEY is not set — cannot revoke the OAuth connection. Local status left unchanged.',
              },
              { status: 503 }
            );
          }
          const nangoRes = await deleteNangoConnection(orgId, provider);
          if (!nangoRes.deleted && !nangoRes.nothingExisted) {
            return NextResponse.json(
              {
                success: false,
                message: `Failed to revoke Nango connection for ${provider}: ${nangoRes.error || 'unknown error'}. Local status left unchanged.`,
              },
              { status: 502 }
            );
          }

          await client.query(
            `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, meta, connected_at)
             VALUES ($1, $2, 'disconnected', NULL, '{}'::jsonb, NULL)
             ON CONFLICT (org_id, channel_type, account_key)
             DO UPDATE SET status = 'disconnected', nango_connection_id = NULL, meta = '{}'::jsonb, connected_at = NULL`,
            [orgId, provider]
          );

          await client.query(
            `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
             VALUES ($1, $2, 'disconnect', 'success', 200, $3)`,
            [
              orgId,
              provider,
              nangoRes.nothingExisted
                ? `${provider} disconnected locally (no Nango connection existed)`
                : `${provider} disconnected (Nango connection deleted)`,
            ]
          );

          await upsertOrgConnector(client, orgId, provider, {
            status: 'disconnected',
            nangoConnectionId: null,
            scopes: [],
            lastOkAt: null,
            lastError: null,
          });

          try {
            await recordAuditEvent(
              {
                orgId,
                kind: 'connector.disconnect',
                actor: { actorType: 'user', userId },
                tool: provider,
                action: 'disconnect',
                resultStatus: 'ok',
                riskClass: 'high',
                payload: { accountId: 'primary', nangoDeleted: Boolean(nangoRes.deleted) },
              },
              { client, orgId }
            );
          } catch {
            // audit_events may be unavailable
          }

          realtimeHub.publish(orgId, { type: 'integration_updated', message: provider });
          return NextResponse.json({ success: true, message: `${provider} disconnected` });
        }

        // QR-linked WhatsApp: unlink the phone and remove the instance first.
        // It has no Nango twin, so the Nango revoke below is skipped for it.
        let qrUnlinked = false;
        if (provider === 'whatsapp') {
          const cur = await client.query(
            `SELECT meta FROM channels WHERE org_id = $1 AND channel_type = 'whatsapp' AND account_key = ''`,
            [orgId]
          );
          const curMeta = cur.rows[0]?.meta as Record<string, unknown> | undefined;
          if (providerIdOf(curMeta) === 'evolution' && typeof curMeta?.evolution_instance === 'string') {
            const stopped = await stopEvolutionInstance(curMeta.evolution_instance);
            if (!stopped.ok) {
              return NextResponse.json(
                { success: false, message: `${stopped.message}. Local status left unchanged.` },
                { status: 502 }
              );
            }
            qrUnlinked = true;
          }
        }

        // BYOK / API-key: clear local secrets; best-effort delete any Nango twin.
        const nangoRes = qrUnlinked
          ? { deleted: false, nothingExisted: true, error: undefined }
          : await deleteNangoConnection(orgId, provider);
        if (isNangoSecretConfigured() && nangoRes.error && !nangoRes.deleted && !nangoRes.nothingExisted) {
          return NextResponse.json(
            {
              success: false,
              message: `Failed to revoke Nango connection for ${provider}: ${nangoRes.error}. Local credentials left unchanged.`,
            },
            { status: 502 }
          );
        }

        await client.query(
          `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, meta, connected_at)
           VALUES ($1, $2, 'disconnected', NULL, '{}'::jsonb, NULL)
           ON CONFLICT (org_id, channel_type, account_key)
           DO UPDATE SET status = 'disconnected', nango_connection_id = NULL, meta = '{}'::jsonb, connected_at = NULL`,
          [orgId, provider]
        );

        await client.query(
          `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
           VALUES ($1, $2, 'disconnect', 'success', 200, $3)`,
          [orgId, provider, `${provider} disconnected (local credentials cleared)`]
        );

        await upsertOrgConnector(client, orgId, provider, {
          status: 'disconnected',
          nangoConnectionId: null,
          scopes: [],
          lastOkAt: null,
          lastError: null,
        });
        // Another number is still linked: it becomes the primary and the connector stays connected.
        if (provider === 'whatsapp' && (await promoteWhatsAppPrimary(client, orgId))) {
          await upsertOrgConnector(client, orgId, 'whatsapp', {
            status: 'connected',
            nangoConnectionId: null,
            scopes: [],
            lastOkAt: new Date(),
            lastError: null,
          });
        }

        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'connector.disconnect',
              actor: { actorType: 'user', userId },
              tool: provider,
              action: 'disconnect',
              resultStatus: 'ok',
              riskClass: 'high',
              payload: { accountId: 'primary', nangoDeleted: Boolean(nangoRes.deleted) },
            },
            { client, orgId }
          );
        } catch {
          // audit_events may be unavailable
        }

        realtimeHub.publish(orgId, { type: 'integration_updated', message: provider });
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
           ON CONFLICT (org_id, channel_type, account_key)
           DO UPDATE SET meta = COALESCE(channels.meta, '{}'::jsonb) || $3::jsonb`,
          [orgId, provider, JSON.stringify(extraMeta)]
        );
        await auditConnectorChange(client, {
          orgId,
          kind: 'settings.update',
          actor: { actorType: 'user', userId },
          tool: provider,
          action: 'update_config',
          resultStatus: 'ok',
          riskClass: 'medium',
          payload: { keys: Object.keys(extraMeta) },
        });
        realtimeHub.publish(orgId, { type: 'integration_updated', message: provider });
        return NextResponse.json({ success: true, message: `${provider} config saved` });
      }

      return NextResponse.json({ message: 'Invalid action. Use "connect", "disconnect", or "update_config".' }, { status: 400 });
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('Integration POST error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
