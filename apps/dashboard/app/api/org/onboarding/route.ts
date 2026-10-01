import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { recommendationPayload } from '@/app/(onboarding)/pack-recommendations';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT wizard_step, business_name, team_size, business_type, channels_selected,
                provisioning_completed_at
         FROM org_onboarding WHERE org_id = $1 LIMIT 1`,
        [orgId]
      );
      const row = res.rows[0];
      const businessType = row?.business_type || '';
      return NextResponse.json({
        orgId,
        wizardStep: row?.wizard_step || 'name',
        businessName: row?.business_name || '',
        teamSize: row?.team_size ?? 5,
        businessType,
        selectedChannels: row?.channels_selected || ['whatsapp', 'email'],
        onboardingComplete: row?.provisioning_completed_at != null,
        ...recommendationPayload(businessType),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
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

      const body = (await request.json().catch(() => ({}))) as {
        wizardStep?: string;
        businessName?: string;
        teamSize?: number;
        businessType?: string;
        selectedChannels?: string[];
        orgId?: string;
        org_id?: string;
      };
      if (body.orgId || body.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }

      const businessName =
        typeof body.businessName === 'string' && body.businessName.trim()
          ? body.businessName.trim()
          : null;

      await client.query(
        `INSERT INTO org_onboarding (org_id, wizard_step, business_name, team_size, business_type, channels_selected)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id) DO UPDATE SET
           wizard_step = COALESCE(EXCLUDED.wizard_step, org_onboarding.wizard_step),
           business_name = COALESCE(EXCLUDED.business_name, org_onboarding.business_name),
           team_size = COALESCE(EXCLUDED.team_size, org_onboarding.team_size),
           business_type = COALESCE(EXCLUDED.business_type, org_onboarding.business_type),
           channels_selected = COALESCE(EXCLUDED.channels_selected, org_onboarding.channels_selected),
           updated_at = NOW()`,
        [
          orgId,
          body.wizardStep || 'name',
          businessName,
          body.teamSize ?? null,
          body.businessType ?? null,
          body.selectedChannels ?? null,
        ]
      );

      // Keep orgs.name in sync whenever the wizard records a business name.
      // Final completion also writes via POST /api/org/create.
      if (businessName) {
        await client.query(`UPDATE orgs SET name = $1, updated_at = NOW() WHERE id = $2`, [
          businessName,
          orgId,
        ]);
      }

      return NextResponse.json({
        status: 'OK',
        orgId,
        ...recommendationPayload(body.businessType),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
