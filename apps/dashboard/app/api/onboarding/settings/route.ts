import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { parseBusinessHours } from '@/lib/onboarding-rollout';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT timezone, business_hours, decision_recipient_id, first_observation_shown_at
         FROM org_onboarding WHERE org_id = $1 LIMIT 1`,
        [orgId]
      );
      const row = res.rows[0];
      return NextResponse.json({
        orgId,
        timezone: row?.timezone || 'UTC',
        businessHours: parseBusinessHours(row?.business_hours),
        decisionRecipientId: row?.decision_recipient_id || null,
        firstObservationShownAt: row?.first_observation_shown_at
          ? new Date(row.first_observation_shown_at).toISOString()
          : null,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/onboarding/settings Error:', err);
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
        timezone?: string;
        businessHours?: unknown;
        decisionRecipientId?: string | null;
        orgId?: string;
        org_id?: string;
      };
      if (body.orgId || body.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }
      const timezone =
        typeof body.timezone === 'string' && body.timezone.length > 0 && body.timezone.length < 80
          ? body.timezone
          : null;
      const hours = body.businessHours === undefined ? null : parseBusinessHours(body.businessHours);
      let recipient = body.decisionRecipientId === '' ? null : body.decisionRecipientId;
      if (recipient) {
        const check = await client.query(`SELECT id FROM users WHERE id = $1 AND org_id = $2`, [
          recipient,
          orgId,
        ]);
        if (!check.rows[0]) {
          return NextResponse.json({ error: 'Recipient must be a member of this org' }, { status: 400 });
        }
      }
      await client.query(
        `INSERT INTO org_onboarding (org_id, wizard_step, timezone, business_hours, decision_recipient_id)
         VALUES ($1, 'name', COALESCE($2, 'UTC'), COALESCE($3::jsonb, '{"start":"09:00","end":"18:00","days":[1,2,3,4,5]}'::jsonb), COALESCE($4::uuid, $5::uuid))
         ON CONFLICT (org_id) DO UPDATE SET
           timezone = COALESCE($2, org_onboarding.timezone),
           business_hours = COALESCE($3::jsonb, org_onboarding.business_hours),
           decision_recipient_id = COALESCE($4::uuid, org_onboarding.decision_recipient_id),
           updated_at = NOW()`,
        [orgId, timezone, hours ? JSON.stringify(hours) : null, recipient ?? null, userId]
      );
      const res = await client.query(
        `SELECT timezone, business_hours, decision_recipient_id, first_observation_shown_at
         FROM org_onboarding WHERE org_id = $1 LIMIT 1`,
        [orgId]
      );
      const row = res.rows[0];
      return NextResponse.json({
        orgId,
        timezone: row?.timezone || 'UTC',
        businessHours: parseBusinessHours(row?.business_hours),
        decisionRecipientId: row?.decision_recipient_id || null,
        firstObservationShownAt: row?.first_observation_shown_at
          ? new Date(row.first_observation_shown_at).toISOString()
          : null,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/onboarding/settings Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
