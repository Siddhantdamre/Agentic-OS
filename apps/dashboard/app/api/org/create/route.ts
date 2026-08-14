import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { applySessionCookies } from '@/lib/session-cookie';
import { recommendationPayload } from '@/app/(onboarding)/pack-recommendations';

const PACK_INSTALL_PATHS = ['/api/packs/install', '/api/packs'];

async function tryInstallRecommendedPacks(
  request: Request,
  packIds: string[]
): Promise<{ attempted: boolean; installed: string[]; failed: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];
  let attempted = false;
  const cookie = request.headers.get('cookie') || '';
  const origin = new URL(request.url).origin;

  for (const packId of packIds) {
    let handled = false;
    for (const path of PACK_INSTALL_PATHS) {
      try {
        const res = await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            cookie,
          },
          body: JSON.stringify({ packId }),
        });
        if (res.status === 404) continue;
        attempted = true;
        handled = true;
        if (res.ok) installed.push(packId);
        else failed.push(packId);
        break;
      } catch {
        // try the next known pack-install path
      }
    }
    if (!handled) {
      // Packs API is not on this branch yet — recommend only, never fake install.
    }
  }

  return { attempted, installed, failed };
}

/**
 * POST /api/org/create
 * Called at the final step of onboarding to persist org name, team size,
 * business type, and selected channels (initial channel seed).
 * Org is resolved from the session — body org_id is ignored.
 */
export async function POST(request: Request) {
  let scoped: Awaited<ReturnType<typeof getScopedClient>> | null = null;
  try {
    scoped = await getScopedClient();
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ status: 'ERROR', message: 'Unauthorized' }, { status: 401 });
    }
    throw err;
  }

  const { client, orgId, userId } = scoped;
  try {
    const body = (await request.json().catch(() => ({}))) as {
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

    await client.query(
      `UPDATE orgs SET name = $1, status = 'active', updated_at = NOW() WHERE id = $2`,
      [businessName, orgId]
    );

    if (channels.length > 0) {
      for (const channelType of channels) {
        await client.query(
          `INSERT INTO channels (org_id, channel_type, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (org_id, channel_type) DO NOTHING`,
          [orgId, channelType]
        );
      }
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

    const recommendation = recommendationPayload(businessType);
    client.release();
    scoped = null;

    const packInstall = await tryInstallRecommendedPacks(request, recommendation.recommendedPacks);

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
      ...recommendation,
    });
    await applySessionCookies(res, { userId, orgId, onboardingComplete: true });
    return res;
  } catch (err) {
    console.error('Org create error:', err);
    return NextResponse.json(
      { status: 'ERROR', message: err instanceof Error ? err.message : 'Failed to create organization' },
      { status: 500 }
    );
  } finally {
    if (scoped) scoped.client.release();
  }
}

