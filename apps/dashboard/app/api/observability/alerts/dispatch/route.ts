import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { dispatchOrgAlerts } from '@/lib/alert-dispatch';
import { tryReadJson } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

/**
 * POST /api/observability/alerts/dispatch
 * Session org only — rejects body org_id. Requires canManageOrgSettings.
 * Posts { orgId, alerts } to DAREX_ALERT_WEBHOOK_URL when set.
 */
export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const body = await tryReadJson<Record<string, unknown>>(request);
      if (body && (body.orgId !== undefined || body.org_id !== undefined)) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }

      const dryRun = body?.dryRun === true;
      const result = await dispatchOrgAlerts(client, orgId, { dryRun });

      if (result.dispatched) {
        try {
          await recordAuditEvent(
            {
              orgId,
              kind: 'settings.update',
              actor: { actorType: 'user', userId },
              action: 'observability.alerts.dispatch',
              resultStatus: 'ok',
              riskClass: 'low',
              payload: {
                alertCount: result.alerts.length,
                keys: result.alerts.map((a) => a.key),
              },
            },
            { client, orgId }
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[alert-dispatch] audit_events insert failed:', message);
        }
      }

      return NextResponse.json(result);
    } finally {
      client.release();
    }
  } catch (err) {
    const scopedAuth = scopedAuthErrorResponse(err);
    if (scopedAuth) return scopedAuth;
    console.error('POST /api/observability/alerts/dispatch Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
