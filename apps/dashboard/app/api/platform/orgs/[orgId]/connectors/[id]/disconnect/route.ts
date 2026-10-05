import { NextResponse } from 'next/server';
import {
  parseConfirmReason,
  requireOperator,
  requirePlatformAdmin,
} from '@/lib/platform-admin';
import {
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';
import { recordAuditEvent } from '@/lib/audit-events';
import { upsertOrgConnector } from '@/lib/connector-registry';
import {
  deleteNangoConnection,
  isNangoSecretConfigured,
} from '@/lib/nango-server';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string; id: string }> };

/**
 * POST /api/platform/orgs/:orgId/connectors/:id/disconnect
 * Same local status update as product disconnect; platform_begin audits first.
 * If Nango is not configured, disconnects locally and says so honestly.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;
    const denied = requireOperator(admin);
    if (denied) return denied;

    const { orgId, id: connectorId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      confirm?: unknown;
      reason?: unknown;
    };
    const parsed = parseConfirmReason(body);
    if (parsed instanceof NextResponse) return parsed;

    const result = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'connector.force_disconnect',
        targetOrgId: orgId,
        targetTable: 'org_connectors',
        targetRowId: connectorId,
        reason: parsed.reason,
      },
      async (client) => {
        const found = await client.query<{
          id: string;
          connector_key: string;
          status: string;
        }>(
          `SELECT id, connector_key, status
             FROM org_connectors
            WHERE org_id = $1
              AND (id::text = $2 OR connector_key = $2)
            LIMIT 1`,
          [orgId, connectorId]
        );
        const row = found.rows[0];
        if (!row) {
          throw Object.assign(new Error('connector_not_found'), { code: 'P404' });
        }

        const provider = row.connector_key;
        let nangoMessage: string;
        let nangoDeleted = false;
        const isDirectChannel = provider === 'whatsapp' || provider === 'razorpay';

        if (isDirectChannel || !isNangoSecretConfigured()) {
          nangoMessage = isDirectChannel
            ? `${provider} disconnected locally`
            : 'NANGO_SECRET_KEY is not set — disconnected locally; OAuth tokens were not revoked in Nango.';
        } else {
          const nangoRes = await deleteNangoConnection(orgId, provider);
          if (!nangoRes.deleted && !nangoRes.nothingExisted && nangoRes.error) {
            throw Object.assign(
              new Error(
                `Failed to revoke Nango connection for ${provider}: ${nangoRes.error}`
              ),
              { code: 'P502' }
            );
          }
          nangoDeleted = Boolean(nangoRes.deleted);
          nangoMessage = nangoRes.nothingExisted
            ? `${provider} disconnected locally (no Nango connection existed)`
            : `${provider} disconnected (Nango connection deleted)`;
        }

        await client.query(
          `INSERT INTO channels (org_id, channel_type, status, nango_connection_id, meta, connected_at)
           VALUES ($1, $2, 'disconnected', NULL, '{}'::jsonb, NULL)
           ON CONFLICT (org_id, channel_type, account_key)
           DO UPDATE SET status = 'disconnected', nango_connection_id = NULL,
                         meta = '{}'::jsonb, connected_at = NULL`,
          [orgId, provider]
        );

        try {
          await client.query(
            `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
             VALUES ($1, $2, 'disconnect', 'success', 200, $3)`,
            [orgId, provider, nangoMessage]
          );
        } catch {
          // channel_logs optional
        }

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
              actor: { actorType: 'user', userId: admin.userId },
              tool: provider,
              action: 'disconnect',
              resultStatus: 'ok',
              riskClass: 'high',
              payload: {
                accountId: 'primary',
                nangoDeleted,
                platformForce: true,
                nangoConfigured: isNangoSecretConfigured(),
              },
            },
            { client, orgId }
          );
        } catch {
          // audit_events may be unavailable or RLS not yet OR platform_audit_ok
        }

        return { connectorId: row.id, connectorKey: provider, message: nangoMessage };
      }
    );

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P404') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (code === 'P502') {
      return NextResponse.json(
        { success: false, message: err instanceof Error ? err.message : 'Nango error' },
        { status: 502 }
      );
    }
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/.../connectors/.../disconnect', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
