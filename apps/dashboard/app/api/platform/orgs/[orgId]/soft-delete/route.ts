import { NextResponse } from 'next/server';
import {
  parseConfirmReason,
  requireOperator,
  requirePlatformAdmin,
} from '@/lib/platform-admin';
import {
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';
import { scheduleOrgPurge } from '@/lib/org-purge';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string }> };

/** POST /api/platform/orgs/:orgId/soft-delete — marks soft_deleted; schedules purge. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;
    const denied = requireOperator(admin);
    if (denied) return denied;

    const { orgId } = await context.params;
    const body = (await jsonBodyOrEmpty(request)) as {
      confirm?: unknown;
      reason?: unknown;
    };
    const parsed = parseConfirmReason(body);
    if (parsed instanceof NextResponse) return parsed;

    await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'org.soft_delete',
        targetOrgId: orgId,
        targetTable: 'orgs',
        targetRowId: orgId,
        reason: parsed.reason,
      },
      async (client) => {
        const res = await client.query(
          `UPDATE orgs
              SET status = 'soft_deleted',
                  deletion_requested_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING id, status, deletion_requested_at`,
          [orgId]
        );
        if (!res.rows[0]) {
          throw Object.assign(new Error('org_not_found'), { code: 'P404' });
        }
        return res.rows[0];
      }
    );

    // Status commit first; purge is fire-and-forget (Temporal/Nango/memory).
    scheduleOrgPurge({
      orgId,
      actorUserId: admin.userId,
      source: 'platform',
    });

    return NextResponse.json({
      ok: true,
      orgId,
      status: 'soft_deleted',
      purge: 'scheduled',
    });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P404') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/orgs/[orgId]/soft-delete', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
