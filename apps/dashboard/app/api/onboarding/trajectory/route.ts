import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { buildTrajectory, STAGED_ROLLOUT_PLAN } from '@/lib/onboarding-rollout';
import { loadRuntimeControls } from '@/lib/employee-metrics-query';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const ledger = await client.query(`SELECT COUNT(*) FILTER (WHERE decision = 'executed') AS approved, COUNT(*) FILTER (WHERE decision IN ('executed','escalated','declined')) AS considered FROM agent_decision_ledger WHERE org_id = $1 AND created_at > NOW() - INTERVAL '14 days'`, [orgId]);
      const graduatedRes = await client.query(`SELECT DISTINCT action_type FROM employee_autonomy_rules WHERE org_id = $1 AND autonomy_tier >= 3 AND reversibility = 'reversible'`, [orgId]);
      const controls = await loadRuntimeControls(client, orgId);
      return NextResponse.json({ orgId, trajectory: buildTrajectory(Number(ledger.rows[0]?.approved || 0), Number(ledger.rows[0]?.considered || 0), graduatedRes.rows.map((r: { action_type: string }) => String(r.action_type))), plan: STAGED_ROLLOUT_PLAN, rolloutStage: controls.rolloutStage, killSwitch: controls.killSwitch });
    } finally { client.release(); }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
