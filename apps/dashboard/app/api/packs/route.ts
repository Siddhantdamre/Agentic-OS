import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { installPackForOrg, isLivePackId, rejectBodyOrgId, uninstallPackForOrg } from './_lib';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
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
        installed: installed.rows.map((row) => ({
          id: row.pack_id,
          packId: row.pack_id,
          status: row.status,
          config: row.config,
          primary: row.is_primary === true,
          installedAt: row.installed_at,
          uninstalledAt: row.uninstalled_at,
        })),
        connectorsMarkedConnected: false,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/org_packs|packs|does not exist|relation/i.test(message)) {
      return NextResponse.json(
        { error: 'Pack tables missing — apply infra/db/migrations/015_packs.sql', orgId: null, installed: [] },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as {
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
      if (!isLivePackId(packId)) {
        return NextResponse.json(
          {
            error: 'Pack is RFC / not live. Quality bar (03 §11) is not met. Connectors were not marked connected.',
            packId,
            connectorsMarkedConnected: false,
          },
          { status: 400 }
        );
      }
      const result = await installPackForOrg(client, orgId, packId);
      return NextResponse.json({
        ...result,
        connectorsMarkedConnected: false,
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

export async function DELETE(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as {
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
      const result = await uninstallPackForOrg(client, orgId, packId);
      return NextResponse.json({
        orgId,
        packId,
        ...result,
        conversationsDeleted: false,
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
