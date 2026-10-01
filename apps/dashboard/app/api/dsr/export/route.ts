import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { canExportDsr, loadHumanRole } from '@/lib/rbac';
import { enqueueDsrExport } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

/**
 * POST /api/dsr/export — enqueue async org export that writes a downloadable
 * JSON artifact. Org is always the session org via getScopedClient().
 * RBAC: owner or admin (canExportDsr). Body org_id is rejected.
 */
export async function POST(request: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const scoped = await getScopedClient();
    const { client, orgId, userId } = scoped;
    let dsrRequestId: string;
    try {
      const role = await loadHumanRole(client, userId);
      if (!canExportDsr(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      // include_files=false: we export knowledge_sources metadata only.
      const reqIns = await client.query<{ id: string }>(
        `INSERT INTO dsr_requests (
           org_id, kind, status, requested_by_user_id,
           include_memory, include_files, include_vectors, progress
         ) VALUES ($1, 'export', 'pending', $2, true, false, true, '{}'::jsonb)
         RETURNING id`,
        [orgId, userId]
      );
      dsrRequestId = reqIns.rows[0].id;

      await recordAuditEvent(
        {
          orgId,
          kind: 'dsr.export',
          actor: { actorType: 'user', userId },
          resultStatus: 'ok',
          payload: { dsrRequestId, status: 'enqueued' },
        },
        { client, orgId }
      );
    } finally {
      client.release();
    }

    const mode = await enqueueDsrExport({
      orgId,
      dsrRequestId,
      requestedByUserId: userId,
    });

    return NextResponse.json(
      {
        dsrRequestId,
        status: 'pending',
        mode,
        downloadPath: `/api/dsr/${dsrRequestId}/download`,
        message:
          'Export job enqueued. When status is completed, download via GET /api/dsr/{id}/download.',
      },
      { status: 202 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/dsr/export Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
