import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
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
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
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
          body.businessName ?? null,
          body.teamSize ?? null,
          body.businessType ?? null,
          body.selectedChannels ?? null,
        ]
      );
      return NextResponse.json({
        status: 'OK',
        orgId,
        ...recommendationPayload(body.businessType),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
