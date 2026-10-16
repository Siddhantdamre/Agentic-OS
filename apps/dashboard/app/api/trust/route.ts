import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canApproveActions, canManageOrgSettings, canReadOperations, loadHumanRole } from '@/lib/rbac';
import { levelRows, sameAsPreviousLevel } from '@/lib/trust-levels';
import { recommendStage } from '@/lib/trust-evidence';
import { collectTrustSnapshot } from '@/lib/trust-query';
import type { RolloutStage } from '@/lib/employee-rollout';

export const dynamic = 'force-dynamic';

const STAGES: RolloutStage[] = [0, 1, 2, 3];

/** Everything the Trust page shows, measured for the session's own workspace. */
export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canReadOperations(role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      const snap = await collectTrustSnapshot(client, orgId);
      return NextResponse.json({
        orgId,
        canManage: canManageOrgSettings(role),
        canReview: canApproveActions(role),
        stage: snap.stage,
        killSwitch: snap.killSwitch,
        since: snap.since,
        sinceApproximate: snap.sinceApproximate,
        levels: STAGES.map((stage) => ({ stage, rows: levelRows(stage), sameAsPrevious: sameAsPreviousLevel(stage) })),
        recommendation: recommendStage(snap.workspace),
        workspace: snap.workspace,
        employees: snap.employees,
        unattributed: snap.unattributed,
        shadow: snap.shadow,
        outcomesTracked: snap.outcomesTracked,
        history: snap.history,
        asOf: snap.asOf,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const auth = scopedAuthErrorResponse(err);
    if (auth) return auth;
    console.error('GET /api/trust Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
