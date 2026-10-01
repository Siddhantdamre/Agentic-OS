import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { canExportDsr, loadHumanRole } from '@/lib/rbac';
import { dsrArtifactRoot } from '@darex/workflows/dist/dsr/run-export';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

/**
 * GET /api/dsr/:id/download — stream the export JSON artifact for this org.
 * Path is resolved under DSR_ARTIFACT_DIR; traversal outside the org folder is rejected.
 * Org from session via getScopedClient(). RBAC: canExportDsr.
 */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const dsrRequestId = params.id;
    if (!dsrRequestId || !/^[0-9a-f-]{36}$/i.test(dsrRequestId)) {
      return NextResponse.json({ error: 'Invalid request id' }, { status: 400 });
    }

    const scoped = await getScopedClient();
    const { client, orgId, userId } = scoped;
    let artifactRel: string | null = null;
    let status: string | null = null;
    try {
      const role = await loadHumanRole(client, userId);
      if (!canExportDsr(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const res = await client.query<{
        kind: string;
        status: string;
        artifact_path: string | null;
      }>(
        `SELECT kind, status, artifact_path
           FROM dsr_requests
          WHERE id = $1 AND org_id = $2`,
        [dsrRequestId, orgId]
      );
      const row = res.rows[0];
      if (!row) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      if (row.kind !== 'export') {
        return NextResponse.json({ error: 'Not an export request' }, { status: 400 });
      }
      status = row.status;
      artifactRel = row.artifact_path;
    } finally {
      client.release();
    }

    if (status !== 'completed' || !artifactRel) {
      return NextResponse.json(
        { error: 'Export artifact not ready', status },
        { status: 409 }
      );
    }

    const root = path.resolve(dsrArtifactRoot());
    const expected = path.resolve(root, orgId, `${dsrRequestId}.json`);
    const abs = path.resolve(root, artifactRel);
    if (abs !== expected) {
      return NextResponse.json({ error: 'Invalid artifact path' }, { status: 400 });
    }
    if (!fs.existsSync(abs)) {
      return NextResponse.json({ error: 'Artifact file missing' }, { status: 404 });
    }

    const body = fs.readFileSync(abs);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="darex-dsr-export-${dsrRequestId}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('GET /api/dsr/[id]/download Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
