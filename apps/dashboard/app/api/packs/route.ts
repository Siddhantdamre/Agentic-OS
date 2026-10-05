import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import {
  LIVE_PACK_IDS,
  installPackForOrg,
  isLivePackId,
  rejectBodyOrgId,
  uninstallPackForOrg,
  upgradePackForOrg,
} from './_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

const LIVE_PACK_IDS_LIST = [...LIVE_PACK_IDS];

function mapInstalledRow(row: {
  pack_id: string;
  status: string;
  config: unknown;
  is_primary: boolean;
  installed_at: unknown;
  uninstalled_at: unknown;
  installed_version?: string;
  last_upgraded_at?: unknown;
}) {
  return {
    id: row.pack_id,
    packId: row.pack_id,
    status: row.status,
    config: row.config,
    primary: row.is_primary === true,
    installedAt: row.installed_at,
    uninstalledAt: row.uninstalled_at,
    installedVersion: row.installed_version ?? '1.0.0',
    lastUpgradedAt: row.last_upgraded_at ?? null,
  };
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const catalog = await client.query(
        `SELECT id, name, version, extends, markets, live, manifest FROM packs ORDER BY id`
      );
      const installed = await client.query(
        `SELECT pack_id, status, config, is_primary, installed_at, uninstalled_at,
                COALESCE(installed_version, '1.0.0') AS installed_version,
                last_upgraded_at
           FROM org_packs WHERE org_id = $1 ORDER BY installed_at NULLS LAST`,
        [orgId]
      );
      return NextResponse.json({
        orgId,
        packs: catalog.rows,
        installed: installed.rows.map(mapInstalledRow),
        livePackIds: LIVE_PACK_IDS_LIST,
        connectorsMarkedConnected: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/installed_version|last_upgraded_at/i.test(message)) {
        const catalog = await client.query(
          `SELECT id, name, version, extends, markets, live, manifest FROM packs ORDER BY id`
        );
        const installed = await client.query(
          `SELECT pack_id, status, config, is_primary, installed_at, uninstalled_at
             FROM org_packs WHERE org_id = $1 ORDER BY installed_at NULLS LAST`,
          [orgId]
        );
        return NextResponse.json({
          orgId,
          packs: catalog.rows,
          installed: installed.rows.map(mapInstalledRow),
          livePackIds: LIVE_PACK_IDS_LIST,
          connectorsMarkedConnected: false,
        });
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (/org_packs|packs|does not exist|relation/i.test(message)) {
      return NextResponse.json(
        {
          error: 'Pack tables missing — apply infra/db/migrations/015_packs.sql',
          orgId: null,
          packs: [],
          installed: [],
          livePackIds: LIVE_PACK_IDS_LIST,
          connectorsMarkedConnected: false,
        },
        { status: 503 }
      );
    }
    console.error('GET /api/packs Error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error', packs: [], installed: [], livePackIds: LIVE_PACK_IDS_LIST },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json(
          { error: 'Only owners and admins can install packs' },
          { status: 403 }
        );
      }
      const body = (await jsonBodyOrEmpty(request)) as {
        packId?: string;
        pack_id?: string;
        action?: string;
        orgId?: string;
        org_id?: string;
      };
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }
      const packId = String(body.packId || body.pack_id || '').trim();
      if (!packId) {
        return NextResponse.json({ error: 'packId is required' }, { status: 400 });
      }
      if (!isLivePackId(packId)) {
        return NextResponse.json(
          {
            error:
              'Pack is RFC / not live. Quality bar (03 §11) is not met. Connectors were not marked connected.',
            packId,
            connectorsMarkedConnected: false,
          },
          { status: 400 }
        );
      }

      const action = String(body.action || 'install').trim().toLowerCase();
      await client.query('BEGIN');
      try {
        if (action === 'upgrade') {
          const result = await upgradePackForOrg(client, orgId, packId, { userId });
          if (result.status === 'failed') {
            await client.query('ROLLBACK');
            return NextResponse.json(
              {
                error: 'Pack upgrade failed — pack must be installed first',
                ...result,
                connectorsMarkedConnected: false,
              },
              { status: 409 }
            );
          }
          await client.query('COMMIT');
          return NextResponse.json({ ...result, connectorsMarkedConnected: false });
        }
        const result = await installPackForOrg(client, orgId, packId, { userId });
        if (result.status === 'failed') {
          await client.query('ROLLBACK');
          return NextResponse.json(
            {
              error: 'Pack install failed',
              ...result,
              connectorsMarkedConnected: false,
            },
            { status: 400 }
          );
        }
        await client.query('COMMIT');
        return NextResponse.json({
          ...result,
          connectorsMarkedConnected: false,
        });
      } catch (installErr) {
        await client.query('ROLLBACK');
        throw installErr;
      }
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    const message = err instanceof Error ? err.message : String(err);
    if (/foreign key|org_packs|packs|does not exist|relation/i.test(message)) {
      return NextResponse.json(
        {
          error:
            'Pack install failed — catalog row missing or pack tables not migrated. Apply infra/db/migrations/015_packs.sql',
          connectorsMarkedConnected: false,
        },
        { status: 503 }
      );
    }
    console.error('POST /api/packs Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json(
          { error: 'Only owners and admins can uninstall packs' },
          { status: 403 }
        );
      }
      const body = (await jsonBodyOrEmpty(request)) as {
        packId?: string;
        pack_id?: string;
        orgId?: string;
        org_id?: string;
      };
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }
      const packId = String(body.packId || body.pack_id || '').trim();
      if (!packId) {
        return NextResponse.json({ error: 'packId is required' }, { status: 400 });
      }
      const result = await uninstallPackForOrg(client, orgId, packId, { userId });
      return NextResponse.json({
        ...result,
        conversationsDeleted: false,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth3 = scopedAuthErrorResponse(err);
    if (__scopedAuth3) return __scopedAuth3;
    const message = err instanceof Error ? err.message : String(err);
    if (/org_packs|packs|does not exist|relation/i.test(message)) {
      return NextResponse.json(
        {
          error: 'Pack tables missing — apply infra/db/migrations/015_packs.sql',
          conversationsDeleted: false,
        },
        { status: 503 }
      );
    }
    console.error('DELETE /api/packs Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
