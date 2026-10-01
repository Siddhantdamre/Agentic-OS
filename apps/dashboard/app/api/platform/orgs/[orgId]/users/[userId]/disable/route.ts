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

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string; userId: string }> };

/**
 * POST /api/platform/orgs/:orgId/users/:userId/disable   { disabled: boolean, confirm, reason }
 * Sets or clears users.disabled_at (migration 206). Disabling also bumps session_epoch so open
 * sessions end immediately; getScopedClient() and requirePlatformAdmin() refuse a disabled user.
 * Operator only. An operator cannot disable themselves.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;
    const denied = requireOperator(admin);
    if (denied) return denied;

    const { orgId, userId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      confirm?: unknown;
      reason?: unknown;
      disabled?: unknown;
    };
    const parsed = parseConfirmReason(body);
    if (parsed instanceof NextResponse) return parsed;
    if (typeof body.disabled !== 'boolean') {
      return NextResponse.json({ error: 'disabled must be a boolean' }, { status: 400 });
    }
    const disabled = body.disabled;
    if (disabled && userId === admin.userId) {
      return NextResponse.json({ error: 'You cannot disable your own account' }, { status: 400 });
    }

    const result = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: disabled ? 'user.disable' : 'user.enable',
        targetOrgId: orgId,
        targetTable: 'users',
        targetRowId: userId,
        reason: parsed.reason,
      },
      async (client) => {
        const member = await client.query(
          `SELECT 1 FROM organization_memberships WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
          [orgId, userId]
        );
        if (!member.rows[0]) {
          throw Object.assign(new Error('not_member'), { code: 'P404' });
        }
        try {
          const res = await client.query<{ disabled: boolean }>(
            `UPDATE users
                SET disabled_at = CASE WHEN $2::boolean THEN COALESCE(disabled_at, NOW()) ELSE NULL END,
                    session_epoch = CASE WHEN $2::boolean THEN session_epoch + 1 ELSE session_epoch END,
                    updated_at = NOW()
              WHERE id = $1
              RETURNING (disabled_at IS NOT NULL) AS disabled`,
            [userId, disabled]
          );
          if (!res.rows[0]) {
            throw Object.assign(new Error('user_not_found'), { code: 'P404' });
          }
          return { disabled: res.rows[0].disabled };
        } catch (err) {
          if (isPlatformSchemaMissing(err)) {
            throw Object.assign(new Error('users.disabled_at is missing — apply migration 206'), { code: 'P503' });
          }
          throw err;
        }
      }
    );

    return NextResponse.json({ ok: true, userId, orgId, ...result });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P404') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (code === 'P503') {
      return NextResponse.json(
        { error: 'platform_migration_pending', message: err instanceof Error ? err.message : 'disabled_at missing' },
        { status: 503 }
      );
    }
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/.../disable', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
