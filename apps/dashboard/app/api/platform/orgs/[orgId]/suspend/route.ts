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

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string }> };

/** POST /api/platform/orgs/:orgId/suspend — operator only. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;
    const denied = requireOperator(admin);
    if (denied) return denied;

    const { orgId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      confirm?: unknown;
      reason?: unknown;
    };
    const parsed = parseConfirmReason(body);
    if (parsed instanceof NextResponse) return parsed;

    await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'org.suspend',
        targetOrgId: orgId,
        targetTable: 'orgs',
        targetRowId: orgId,
        reason: parsed.reason,
      },
      async (client) => {
        const res = await client.query(
          `UPDATE orgs
              SET status = 'suspended',
                  suspended_by = 'platform',
                  suspended_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1
            RETURNING id, status, suspended_by, suspended_at`,
          [orgId]
        );
        if (!res.rows[0]) {
          throw Object.assign(new Error('org_not_found'), { code: 'P404' });
        }
        return res.rows[0];
      }
    );

    return NextResponse.json({ ok: true, orgId, status: 'suspended' });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P404') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/orgs/[orgId]/suspend', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
