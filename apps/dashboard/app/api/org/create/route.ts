import { NextResponse } from 'next/server';
import { issueSessionCookies } from '@/lib/session-epoch';
import type { PoolClient } from 'pg';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

import { recommendationPayload } from '@/app/(onboarding)/pack-recommendations';
import { seedDefaultEmployees } from '@/lib/employee-provision';
import { seedColdStart } from '@darex/workflows/dist/cold-start';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { upsertOrgMembership } from '@/lib/auth-security';
import { recordAuditEvent } from '@/lib/audit-events';
import { installPackForOrg, isLivePackId } from '@/app/api/packs/_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { publicErrorMessage } from '@/lib/public-error';

/**
 * Install recommended packs via the canonical dashboard installer
 * (`installPackForOrg` from packs/_lib). Session org only — never body org_id.
 * Non-live ids are skipped (not reported as installed).
 */
async function installRecommendedPacks(
  client: PoolClient,
  orgId: string,
  userId: string,
  packIds: string[]
): Promise<{ attempted: boolean; installed: string[]; failed: string[]; skipped: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const liveIds = packIds.filter((id) => {
    if (isLivePackId(id)) return true;
    skipped.push(id);
    return false;
  });

  if (liveIds.length === 0) {
    return { attempted: false, installed, failed, skipped };
  }

  await client.query('BEGIN');
  try {
    for (const packId of liveIds) {
      const result = await installPackForOrg(client, orgId, packId, { userId });
      if (result.status === 'installed') {
        installed.push(packId);
      } else {
        failed.push(packId);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }

  return { attempted: true, installed, failed, skipped };
}

/**
 * POST /api/org/create
 * Final onboarding step. Org resolved from session — body org_id rejected.
 * DB writes (name, channels, onboarding) run in one transaction; employee seed
 * and pack install run after commit (seed has its own txn; packs use installPackForOrg).
 */
export async function POST(request: Request) {
  let scoped: Awaited<ReturnType<typeof getScopedClient>> | null = null;
  try {
    scoped = await getScopedClient();
  } catch (err) {
    const authErr = scopedAuthErrorResponse(err);
    if (authErr) return authErr;
    throw err;
  }

  const { client, orgId, userId } = scoped;
  try {
    const role = await loadHumanRole(client, userId);
    if (!canManageOrgSettings(role)) {
      return NextResponse.json({ status: 'ERROR', message: 'Forbidden' }, { status: 403 });
    }

    const body = (await jsonBodyOrEmpty(request)) as {
      businessName?: string;
      teamSize?: number;
      businessType?: string;
      channels?: string[];
      orgId?: string;
      org_id?: string;
    };

    if (body.orgId || body.org_id) {
      return NextResponse.json(
        { status: 'ERROR', message: 'org_id is not accepted from the client; it is resolved from the session.' },
        { status: 400 }
      );
    }

    const businessName = typeof body.businessName === 'string' ? body.businessName.trim() : '';
    if (!businessName) {
      return NextResponse.json({ status: 'ERROR', message: 'Business name is required' }, { status: 400 });
    }

    const teamSize = typeof body.teamSize === 'number' ? body.teamSize : null;
    const businessType = typeof body.businessType === 'string' ? body.businessType : null;
    const channels = Array.isArray(body.channels)
      ? body.channels.filter((c): c is string => typeof c === 'string' && c.length > 0)
      : [];

    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE orgs SET name = $1, status = 'active', updated_at = NOW() WHERE id = $2`,
        [businessName, orgId]
      );

      for (const channelType of channels) {
        await client.query(
          `INSERT INTO channels (org_id, channel_type, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (org_id, channel_type, account_key) DO NOTHING`,
          [orgId, channelType]
        );
      }

      await client.query(
        `INSERT INTO org_onboarding (
           org_id, wizard_step, business_name, team_size, business_type,
           channels_selected, provisioning_started_at, provisioning_completed_at, updated_at
         ) VALUES ($1, 'channels', $2, $3, $4, $5, NOW(), NOW(), NOW())
         ON CONFLICT (org_id) DO UPDATE SET
           wizard_step = 'channels',
           business_name = EXCLUDED.business_name,
           team_size = EXCLUDED.team_size,
           business_type = EXCLUDED.business_type,
           channels_selected = EXCLUDED.channels_selected,
           provisioning_started_at = COALESCE(org_onboarding.provisioning_started_at, NOW()),
           provisioning_completed_at = NOW(),
           updated_at = NOW()`,
        [orgId, businessName, teamSize, businessType, channels]
      );

      await upsertOrgMembership(client, userId, orgId, role, true);
      await client.query('COMMIT');
    } catch (txnErr) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw txnErr;
    }

    // Own transaction inside seedDefaultEmployees — after org txn commits.
    await seedDefaultEmployees(client, orgId);
    const coldStart = seedColdStart(0);

    const recommendation = recommendationPayload(businessType);
    // Canonical packs installer (same path as POST /api/packs) — session org only.
    const packInstall = await installRecommendedPacks(
      client,
      orgId,
      userId,
      recommendation.recommendedPacks
    );

    try {
      await recordAuditEvent({
        orgId,
        kind: 'settings.update',
        actor: { actorType: 'user', userId },
        action: 'onboarding.complete',
        resultStatus: 'ok',
        payload: {
          businessName,
          channelsSeeded: channels.length,
          packsInstalled: packInstall.installed,
          packsFailed: packInstall.failed,
          coldStartPhase: coldStart.phase,
        },
      });
    } catch {
      // audit is best-effort
    }

    client.release();
    scoped = null;

    const res = NextResponse.json({
      status: 'OK',
      orgId,
      businessName,
      teamSize,
      businessType,
      channelsSeeded: channels.length,
      channelsStatus: 'pending',
      connectorsMarkedConnected: false,
      packInstall,
      coldStart,
      ...recommendation,
    });
    await issueSessionCookies(res, { userId, orgId, onboardingComplete: true });
    return res;
  } catch (err) {
    console.error('Org create error:', err);
    return NextResponse.json(
      { status: 'ERROR', message: publicErrorMessage(err, 'Failed to create organization') },
      { status: 500 }
    );
  } finally {
    if (scoped) scoped.client.release();
  }
}
