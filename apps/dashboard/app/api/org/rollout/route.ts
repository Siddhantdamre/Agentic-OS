import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { recordAuditEvent } from '@/lib/audit-events';
import { collectTrustSnapshot } from '@/lib/trust-query';
import { changeStage } from '@/lib/trust-stage';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const snap = await collectTrustSnapshot(client, orgId);
      return NextResponse.json({
        orgId,
        stage: snap.stage,
        killSwitch: snap.killSwitch,
        shadowReviewed: snap.workspace.shadowReviewed,
        shadowAgreed: snap.workspace.shadowAgreed,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/org/rollout Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * Move the workspace to another autonomy level.
 * Body: { stage: 0-3, force?: boolean, reason?: string }. The evidence for moving up is
 * measured on the server; any numbers in the body are ignored (see lib/trust-stage.ts).
 */
export async function PATCH(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const body = (await jsonBodyOrEmpty(request)) as { stage?: unknown; force?: unknown; reason?: unknown; orgId?: string; org_id?: string };
      if (body.orgId || body.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }

      const result = await changeStage(client, orgId, userId, body);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error, stage: result.stage, requirements: result.requirements },
          { status: result.status }
        );
      }
      if (result.unchanged) {
        return NextResponse.json({ orgId, stage: result.stage, demoted: false });
      }

      await recordAuditEvent(
        {
          orgId,
          kind: 'settings.update',
          actor: { actorType: 'user', userId },
          resultStatus: 'ok',
          payload: { setting: 'autonomy_stage', from: result.from, to: result.stage, kind: result.kind },
        },
        { client, orgId }
      ).catch((err: unknown) => console.warn('rollout audit write failed:', err));

      return NextResponse.json({
        orgId,
        stage: result.stage,
        demoted: result.kind === 'pull_back',
        reason: result.reason,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/org/rollout Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
