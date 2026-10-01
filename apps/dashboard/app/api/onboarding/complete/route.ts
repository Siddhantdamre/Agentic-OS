import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { seedDefaultEmployees } from '@/lib/employee-provision';
import { seedColdStart } from '@darex/workflows/dist/cold-start';
import { issueSessionCookies } from '@/lib/session-epoch';

export async function POST() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      await client.query(
        `INSERT INTO org_onboarding (org_id, wizard_step, provisioning_completed_at, updated_at)
         VALUES ($1, 'complete', NOW(), NOW())
         ON CONFLICT (org_id) DO UPDATE SET
           wizard_step = 'complete',
           provisioning_completed_at = COALESCE(org_onboarding.provisioning_completed_at, NOW()),
           updated_at = NOW()`,
        [orgId]
      );

      await seedDefaultEmployees(client, orgId);
      const coldStart = seedColdStart(0);

      const res = NextResponse.json({
        status: 'OK',
        orgId,
        onboardingComplete: true,
        coldStart,
      });

      await issueSessionCookies(res, { userId, orgId, onboardingComplete: true });
      return res;
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
