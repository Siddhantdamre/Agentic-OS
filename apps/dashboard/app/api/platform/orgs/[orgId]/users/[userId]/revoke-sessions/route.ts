import { NextResponse } from 'next/server';
import {
  parseConfirmReason,
  requireOperator,
  requirePlatformAdmin,
} from '@/lib/platform-admin';
import {
  isPlatformSchemaMissing,
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { publicErrorMessage } from '@/lib/public-error';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string; userId: string }> };

/**
 * POST /api/platform/orgs/:orgId/users/:userId/revoke-sessions
 * Increments users.session_epoch (migration 121).
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;
    const denied = requireOperator(admin);
    if (denied) return denied;

    const { orgId, userId } = await context.params;
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
        action: 'user.revoke_sessions',
        targetOrgId: orgId,
        targetTable: 'users',
        targetRowId: userId,
        reason: parsed.reason,
      },
      async (client) => {
        const member = await client.query(
          `SELECT 1 FROM organization_memberships
            WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
          [orgId, userId]
        );
        if (!member.rows[0]) {
          throw Object.assign(new Error('not_member'), { code: 'P404' });
        }

        try {
          const res = await client.query<{ session_epoch: number }>(
            `UPDATE users
                SET session_epoch = session_epoch + 1,
                    updated_at = NOW()
              WHERE id = $1
              RETURNING session_epoch`,
            [userId]
          );
          if (!res.rows[0]) {
            throw Object.assign(new Error('user_not_found'), { code: 'P404' });
          }
          return { sessionEpoch: res.rows[0].session_epoch };
        } catch (err) {
          if (isPlatformSchemaMissing(err)) {
            throw Object.assign(
              new Error(
                'users.session_epoch is missing — apply migration 121'
              ),
              { code: 'P503' }
            );
          }
          throw err;
        }
      }
    );

    return NextResponse.json({ ok: true, userId, orgId, ...result });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P404') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (code === 'P503') {
      return NextResponse.json(
        {
          error: 'platform_migration_pending',
          message: publicErrorMessage(err, 'session_epoch missing'),
        },
        { status: 503 }
      );
    }
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/.../revoke-sessions', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
