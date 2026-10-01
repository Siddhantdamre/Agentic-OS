import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { matchesDsrDeleteConfirm } from '@/lib/dsr-confirm';
import { recordAuditEvent } from '@/lib/audit-events';
import { canDeleteDsr, loadHumanRole } from '@/lib/rbac';
import { enqueueDsrDelete } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

/**
 * POST /api/dsr/delete — enqueue async org hard-delete (Temporal + resumable
 * progress). Requires typed confirmation of the org slug or name.
 * Org is always the session org via getScopedClient(); body org_id is rejected.
 * RBAC: owner only (canDeleteDsr).
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

    const confirm = body.confirm ?? body.confirmation ?? body.confirmSlug;
    if (typeof confirm !== 'string' || !confirm.trim()) {
      return NextResponse.json(
        {
          error:
            'Typed confirmation required. Send { "confirm": "<org slug or exact name>" } to proceed.',
        },
        { status: 400 }
      );
    }

    const scoped = await getScopedClient();
    const { client, orgId, userId } = scoped;
    let dsrRequestId: string;
    try {
      const role = await loadHumanRole(client, userId);
      if (!canDeleteDsr(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const orgRes = await client.query<{ name: string; slug: string }>(
        `SELECT name, slug FROM orgs WHERE id = $1`,
        [orgId]
      );
      const org = orgRes.rows[0];
      if (!org) {
        return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
      }
      if (!matchesDsrDeleteConfirm({ confirm, orgSlug: org.slug, orgName: org.name })) {
        return NextResponse.json(
          {
            error:
              'Confirmation does not match this organization. Type the org slug or exact name to confirm delete.',
          },
          { status: 400 }
        );
      }

      const reqIns = await client.query<{ id: string }>(
        `INSERT INTO dsr_requests (
           org_id, kind, status, requested_by_user_id,
           include_memory, include_files, include_vectors, progress
         ) VALUES ($1, 'delete', 'pending', $2, true, true, true, '{}'::jsonb)
         RETURNING id`,
        [orgId, userId]
      );
      dsrRequestId = reqIns.rows[0].id;

      await recordAuditEvent(
        {
          orgId,
          kind: 'dsr.delete',
          actor: { actorType: 'user', userId },
          resultStatus: 'ok',
          payload: { dsrRequestId, status: 'enqueued' },
        },
        { client, orgId }
      );
    } finally {
      client.release();
    }

    // Pool released before Temporal / async work.
    const mode = await enqueueDsrDelete({
      orgId,
      dsrRequestId,
      requestedByUserId: userId,
    });

    return NextResponse.json(
      {
        dsrRequestId,
        status: 'pending',
        mode,
        message: 'Delete job enqueued. Poll GET /api/dsr for progress.',
      },
      { status: 202 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/dsr/delete Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
