import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { IMPERSONATION_COOKIE } from '@/lib/platform-admin';
import {
  isPlatformSchemaMissing,
  platformErrorResponse,
  withPlatformTransaction,
  type PlatformRole,
} from '@/lib/platform-db';
import {
  clearSessionCookies,
  cookieSecure,
  parseSessionCookie,
  SESSION_COOKIE,
} from '@/lib/session-cookie';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/platform/impersonation/end
 *
 * After start, the browser session is the *target* user — not in platform_admins.
 * Auth: httpOnly darex_impersonation cookie (`sessionId.actorUserId.role`) plus a
 * matching open row. Sets ended_at and increments target session_epoch.
 */
export async function POST() {
  try {
    const cookieStore = await cookies();
    const sessionUserId = await parseSessionCookie(
      cookieStore.get(SESSION_COOKIE)?.value
    );
    if (!sessionUserId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const raw = cookieStore.get(IMPERSONATION_COOKIE)?.value || '';
    const parts = raw.split('.');
    const impersonationId = parts[0] || '';
    const actorFromCookie = parts[1] || '';
    const rolePart = parts[2] || '';
    if (!impersonationId || !UUID_RE.test(impersonationId)) {
      return NextResponse.json(
        { error: 'no_impersonation', message: 'No active impersonation cookie' },
        { status: 400 }
      );
    }
    if (!actorFromCookie || !UUID_RE.test(actorFromCookie)) {
      return NextResponse.json(
        { error: 'no_impersonation', message: 'Invalid impersonation cookie' },
        { status: 400 }
      );
    }

    const actorRole: PlatformRole =
      rolePart === 'operator' || rolePart === 'support' ? rolePart : 'support';

    await withPlatformTransaction(
      {
        actorUserId: actorFromCookie,
        platformRole: actorRole,
        action: 'impersonation.end',
        targetTable: 'impersonation_sessions',
        targetRowId: impersonationId,
        reason: 'end',
      },
      async (client) => {
        let targetUserId: string | null = null;
        try {
          const res = await client.query<{ target_user_id: string }>(
            `UPDATE impersonation_sessions
                SET ended_at = NOW()
              WHERE id = $1
                AND actor_user_id = $2
                AND target_user_id = $3
                AND ended_at IS NULL
              RETURNING target_user_id`,
            [impersonationId, actorFromCookie, sessionUserId]
          );
          targetUserId = res.rows[0]?.target_user_id ?? null;
        } catch (err) {
          if (isPlatformSchemaMissing(err)) {
            throw Object.assign(
              new Error('impersonation_sessions missing — apply migration 121'),
              { code: 'P503' }
            );
          }
          throw err;
        }

        if (!targetUserId) {
          throw Object.assign(new Error('not_found'), { code: 'P404' });
        }

        try {
          await client.query(
            `UPDATE users
                SET session_epoch = session_epoch + 1,
                    updated_at = NOW()
              WHERE id = $1`,
            [targetUserId]
          );
        } catch (err) {
          if (!isPlatformSchemaMissing(err)) throw err;
        }
      }
    );

    const res = NextResponse.json({ ok: true });
    clearSessionCookies(res);
    res.cookies.set(IMPERSONATION_COOKIE, '', {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return res;
  } catch (err) {
    if ((err as { code?: string })?.code === 'P404') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if ((err as { code?: string })?.code === 'P503') {
      return NextResponse.json(
        {
          error: 'platform_migration_pending',
          message: err instanceof Error ? err.message : 'migration pending',
        },
        { status: 503 }
      );
    }
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/impersonation/end', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
