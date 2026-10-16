import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { canExportDsr, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

/**
 * GET /api/dsr — list this org's DSR export/delete jobs (history + progress).
 * Org from session via getScopedClient(). RBAC: canExportDsr (owner/admin).
 */
export async function GET() {
  try {
    const scoped = await getScopedClient();
    const { client, orgId, userId } = scoped;
    try {
      const role = await loadHumanRole(client, userId);
      if (!canExportDsr(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const res = await client.query(
        `SELECT id, kind, status, include_memory, include_files, include_vectors,
                progress, result, artifact_path, error,
                requested_by_user_id, created_at, completed_at
           FROM dsr_requests
          WHERE org_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [orgId]
      );

      const requests = res.rows.map((row) => ({
        id: row.id as string,
        kind: row.kind as string,
        status: row.status as string,
        includeMemory: row.include_memory as boolean,
        includeFiles: row.include_files as boolean,
        includeVectors: row.include_vectors as boolean,
        progress: row.progress ?? {},
        result: row.result ?? {},
        artifactPath: (row.artifact_path as string | null) ?? null,
        downloadPath:
          row.kind === 'export' && row.status === 'completed' && row.artifact_path
            ? `/api/dsr/${row.id}/download`
            : null,
        error: (row.error as string | null) ?? null,
        requestedByUserId: row.requested_by_user_id as string,
        createdAt: row.created_at as string,
        completedAt: (row.completed_at as string | null) ?? null,
      }));

      return NextResponse.json({ requests });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('GET /api/dsr Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
