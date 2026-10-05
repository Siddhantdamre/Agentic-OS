import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { loadRuntimeControls, writeRolloutStage } from '@/lib/employee-metrics-query';
import { canAdvanceStage, parseRolloutStage } from '@/lib/employee-rollout';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const c = await loadRuntimeControls(client, orgId);
      return NextResponse.json({
        orgId,
        stage: c.rolloutStage,
        killSwitch: c.killSwitch,
        shadowReviewed: c.shadowReviewed,
        shadowAgreed: c.shadowAgreed,
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

export async function PATCH(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const body = (await jsonBodyOrEmpty(request)) as {
        stage?: number;
        force?: boolean;
        orgId?: string;
        org_id?: string;
        weeksInStage?: number;
        stateDivergences?: number;
        approvalRate?: number | null;
        decisionsInStage?: number;
      };
      if (body.orgId || body.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }
      const target = parseRolloutStage(body.stage);
      const controls = await loadRuntimeControls(client, orgId);
      if (target <= controls.rolloutStage) {
        if (target < controls.rolloutStage) await writeRolloutStage(client, orgId, target);
        return NextResponse.json({ orgId, stage: target, demoted: target < controls.rolloutStage });
      }
      if (target !== controls.rolloutStage + 1) {
        return NextResponse.json({ error: 'Advance one stage at a time' }, { status: 400 });
      }
      const check = canAdvanceStage({
        from: controls.rolloutStage,
        shadowReviewed: controls.shadowReviewed,
        shadowAgreed: controls.shadowAgreed,
        weeksInStage: Number(body.weeksInStage || 0),
        stateDivergences: Number(body.stateDivergences || 0),
        approvalRate: body.approvalRate ?? null,
        decisionsInStage: Number(body.decisionsInStage || 0),
      });
      if (!check.ok && !body.force) {
        return NextResponse.json({ error: check.reason, stage: controls.rolloutStage }, { status: 409 });
      }
      await writeRolloutStage(client, orgId, target);
      return NextResponse.json({ orgId, stage: target, reason: check.reason });
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
