import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { loadRuntimeControls, writeKillSwitch } from '@/lib/employee-metrics-query';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

async function payload(client: Parameters<typeof loadRuntimeControls>[0], orgId: string) {
  const c = await loadRuntimeControls(client, orgId);
  return { orgId, enabled: c.killSwitch, active: c.killSwitch, rolloutStage: c.rolloutStage };
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      return NextResponse.json(await payload(client, orgId));
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/org/kill-switch Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

async function write(request: Request) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, userId);
    if (!canManageOrgSettings(role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = (await jsonBodyOrEmpty(request)) as {
      enabled?: boolean;
      active?: boolean;
      orgId?: string;
      org_id?: string;
    };
    if (body.orgId || body.org_id) {
      return NextResponse.json(
        { error: 'org_id is not accepted from the client; it is resolved from the session.' },
        { status: 400 }
      );
    }
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : body.active;
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled/active must be a boolean' }, { status: 400 });
    }
    await writeKillSwitch(client, orgId, enabled, userId);
    try {
      await recordAuditEvent(
        {
          orgId,
          kind: 'settings.update',
          actor: { actorType: 'user', userId },
          action: 'kill_switch.toggle',
          resultStatus: 'ok',
          riskClass: 'critical',
          payload: { enabled },
        },
        { client, orgId }
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[kill-switch] audit_events insert failed:', message);
    }
    return NextResponse.json(await payload(client, orgId));
  } finally {
    client.release();
  }
}

export async function PATCH(request: Request) {
  try {
    return await write(request);
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/org/kill-switch Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return PATCH(request);
}
