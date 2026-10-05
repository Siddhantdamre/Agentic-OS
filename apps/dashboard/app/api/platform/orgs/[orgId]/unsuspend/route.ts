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
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string }> };

/**
 * POST /api/platform/orgs/:orgId/unsuspend — clears platform suspension only.
 * Refuses soft_deleted. Does not clear dunning suspensions.
 */
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

    const result = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'org.unsuspend',
        targetOrgId: orgId,
        targetTable: 'orgs',
        targetRowId: orgId,
        reason: parsed.reason,
      },
      async (client) => {
        const current = await client.query<{ status: string; suspended_by: string | null }>(
          `SELECT status, suspended_by FROM orgs WHERE id = $1 LIMIT 1`,
          [orgId]
        );
        const row = current.rows[0];
        if (!row) {
          throw Object.assign(new Error('org_not_found'), { code: 'P404' });
        }
        if (row.status === 'soft_deleted') {
          throw Object.assign(new Error('soft_deleted'), { code: 'P409' });
        }
        if (row.suspended_by !== 'platform') {
          throw Object.assign(new Error('not_platform_suspension'), { code: 'P409' });
        }
        const res = await client.query(
          `UPDATE orgs
              SET status = 'active',
                  suspended_by = NULL,
                  suspended_at = NULL,
                  updated_at = NOW()
            WHERE id = $1 AND suspended_by = 'platform'
            RETURNING id, status`,
          [orgId]
        );
        return res.rows[0];
      }
    );

    return NextResponse.json({ ok: true, orgId, status: result?.status ?? 'active' });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P404') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (code === 'P409') {
      return NextResponse.json(
        {
          error: 'conflict',
          message:
            err instanceof Error ? err.message : 'Cannot unsuspend this org',
        },
        { status: 409 }
      );
    }
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/orgs/[orgId]/unsuspend', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
