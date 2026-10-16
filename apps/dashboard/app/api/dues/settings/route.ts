import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { readDuesSettings } from '@/lib/dues-view';

export const dynamic = 'force-dynamic';

/**
 * The two facts the interest figure depends on, set by the owner: the current RBI bank rate they have checked,
 * and whether the business is a registered micro or small supplier. Without both, no interest is shown.
 */
export async function PUT(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Only an owner or admin can change these settings.' }, { status: 403 });
      }
      const rate = body.bankRatePercent === null || body.bankRatePercent === '' ? null : Number(body.bankRatePercent);
      if (rate !== null && !(Number.isFinite(rate) && rate > 0 && rate <= 25)) {
        return NextResponse.json({ error: 'Enter the bank rate as a percentage between 0 and 25, for example 5.5.' }, { status: 400 });
      }
      const settings = { bankRatePercent: rate, msmeRegistered: body.msmeRegistered === true };
      await client.query(
        `UPDATE orgs SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('dues_settings', $2::jsonb) WHERE id = $1`,
        [orgId, JSON.stringify(settings)],
      );
      return NextResponse.json({ settings: readDuesSettings({ dues_settings: settings }) });
    } finally {
      client.release();
    }
  } catch (err) {
    const scoped = scopedAuthErrorResponse(err);
    if (scoped) return scoped;
    console.error('PUT /api/dues/settings Error:', err);
    return NextResponse.json({ error: 'Could not save that. Please try again.' }, { status: 500 });
  }
}
