import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { isLivePackId, rejectBodyOrgId, updatePackConfig } from '../../_lib';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/packs/[id]/config
 * Merge JSON config into org_packs.config for the session org. Never trusts body org_id.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const params = await Promise.resolve(context.params);
    const packId = String(params.id || '').trim();
    if (!packId) {
      return NextResponse.json({ error: 'pack id is required' }, { status: 400 });
    }
    if (!isLivePackId(packId)) {
      return NextResponse.json({ error: 'Pack is not live / unknown' }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      config?: unknown;
      orgId?: unknown;
      org_id?: unknown;
    };
    const rejected = rejectBodyOrgId(body);
    if (rejected) {
      return NextResponse.json({ error: rejected }, { status: 400 });
    }
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
      return NextResponse.json({ error: 'config object is required' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json(
          { error: 'Only owners and admins can update pack config' },
          { status: 403 }
        );
      }
      const updated = await updatePackConfig(
        client,
        orgId,
        packId,
        body.config as Record<string, unknown>,
        { userId }
      );
      if (!updated) {
        return NextResponse.json({ error: 'Pack not installed' }, { status: 404 });
      }
      return NextResponse.json({ success: true, pack: updated });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (/org_packs|packs|does not exist|relation/i.test(message)) {
      return NextResponse.json(
        { error: 'Pack tables missing — apply infra/db/migrations/015_packs.sql' },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
