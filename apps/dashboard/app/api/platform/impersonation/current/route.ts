import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

const IMPERSONATION_COOKIE = 'darex_impersonation';

type ImpersonationRow = {
  id: string;
  actor_user_id: string;
  target_user_id: string;
  target_org_id: string;
  expires_at: string;
  break_glass: boolean;
  reason: string;
  actor_email: string | null;
};

/**
 * GET /api/platform/impersonation/current
 *
 * Banner read for the *target* session. Uses the normal darex_app pool and the
 * impersonation_sessions target-read RLS policy (migration 121). Honest empty
 * when the table is missing or there is no open session — never invents a banner.
 */
export async function GET() {
  try {
    const cookieStore = await cookies();
    const rawCookie = cookieStore.get(IMPERSONATION_COOKIE)?.value?.trim() || null;
    // Cookie may be bare session id or `${sessionId}.${actorUserId}.${role}`.
    const cookieSessionId = rawCookie ? rawCookie.split('.')[0] || null : null;

    const { client, userId } = await getScopedClient({ allowSuspended: true });
    try {
      // Open session for the current user (target-read RLS). Cookie is advisory.
      const res = await client.query<ImpersonationRow>(
        `
        SELECT
          s.id,
          s.actor_user_id,
          s.target_user_id,
          s.target_org_id,
          s.expires_at,
          s.break_glass,
          s.reason,
          u.email AS actor_email
        FROM impersonation_sessions s
        LEFT JOIN users u ON u.id = s.actor_user_id
        WHERE s.target_user_id = $1
          AND s.ended_at IS NULL
          AND s.expires_at > NOW()
        ORDER BY
          CASE WHEN $2::text IS NOT NULL AND s.id::text = $2 THEN 0 ELSE 1 END,
          s.expires_at DESC
        LIMIT 1
        `,
        [userId, cookieSessionId]
      );
      const row = res.rows[0];
      if (!row) {
        return NextResponse.json({ active: false });
      }

      return NextResponse.json({
        active: true,
        sessionId: row.id,
        actorUserId: row.actor_user_id,
        actorEmail: row.actor_email,
        targetUserId: row.target_user_id,
        targetOrgId: row.target_org_id,
        expiresAt: row.expires_at,
        breakGlass: row.break_glass,
        reason: row.reason,
        cookiePresent: Boolean(rawCookie),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const auth = scopedAuthErrorResponse(err);
    if (auth) return auth;

    // Missing relation / migration not applied → honest empty, not a fake banner.
    const message = err instanceof Error ? err.message : String(err);
    const missingTable =
      /relation .* does not exist/i.test(message) ||
      /impersonation_sessions/i.test(message) ||
      /undefined_table/i.test(message);
    if (missingTable) {
      return NextResponse.json({ active: false, tableMissing: true });
    }

    console.error('[platform/impersonation/current]', err);
    return NextResponse.json({ active: false });
  }
}
