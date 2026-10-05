import { NextResponse } from 'next/server';
import {
  IMPERSONATION_COOKIE,
  IMPERSONATION_MAX_MINUTES,
  parseConfirmReason,
  requirePlatformAdmin,
} from '@/lib/platform-admin';
import {
  isPlatformSchemaMissing,
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';
import {
  applySessionCookies,
  cookieSecure,
} from '@/lib/session-cookie';
import { jsonBodyOrEmpty } from '@/lib/safe-json';
import { publicErrorMessage } from '@/lib/public-error';

export const dynamic = 'force-dynamic';

type ImpersonationBody = {
  confirm?: unknown;
  reason?: unknown;
  targetUserId?: unknown;
  target_user_id?: unknown;
  targetOrgId?: unknown;
  target_org_id?: unknown;
  breakGlass?: unknown;
  break_glass?: unknown;
};

/**
 * POST /api/platform/impersonation
 *
 * Consent path requires orgs.support_access_enabled (migration 121). Missing
 * column → 503. Session cookie is userId.epoch.sig via applySessionCookies.
 */
export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;

    const body = (await jsonBodyOrEmpty(request)) as ImpersonationBody;
    const parsed = parseConfirmReason(body);
    if (parsed instanceof NextResponse) return parsed;

    const targetUserId =
      typeof body.targetUserId === 'string'
        ? body.targetUserId
        : typeof body.target_user_id === 'string'
          ? body.target_user_id
          : '';
    const targetOrgId =
      typeof body.targetOrgId === 'string'
        ? body.targetOrgId
        : typeof body.target_org_id === 'string'
          ? body.target_org_id
          : '';
    if (!targetUserId || !targetOrgId) {
      return NextResponse.json(
        { error: 'target_required', message: 'targetUserId and targetOrgId are required' },
        { status: 400 }
      );
    }

    const breakGlass = body.breakGlass === true || body.break_glass === true;
    if (breakGlass && admin.platformRole !== 'operator') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    type SessionRow = {
      id: string;
      expires_at: Date;
      break_glass: boolean;
      consent_recorded_at: Date | null;
      session_epoch: number;
    };

    const session = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'impersonation.start',
        targetOrgId,
        targetTable: 'users',
        targetRowId: targetUserId,
        reason: parsed.reason,
      },
      async (client, auditId) => {
        const member = await client.query(
          `SELECT 1 FROM organization_memberships
            WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
          [targetOrgId, targetUserId]
        );
        if (!member.rows[0]) {
          throw Object.assign(new Error('not_member'), { code: 'P404' });
        }

        let consentAt: Date | null = null;
        if (!breakGlass) {
          try {
            const sa = await client.query<{ support_access_enabled: boolean }>(
              `SELECT support_access_enabled FROM orgs WHERE id = $1`,
              [targetOrgId]
            );
            if (!sa.rows[0]?.support_access_enabled) {
              throw Object.assign(new Error('support_access_disabled'), { code: 'P403' });
            }
            consentAt = new Date();
          } catch (err) {
            if ((err as { code?: string })?.code === 'P403') throw err;
            if (isPlatformSchemaMissing(err)) {
              // Column from migration 121 — not applied yet.
              throw Object.assign(
                new Error(
                  'orgs.support_access_enabled is missing — apply migration 121'
                ),
                { code: 'P503' }
              );
            }
            throw err;
          }
        }

        const expiresAt = new Date(
          Date.now() + IMPERSONATION_MAX_MINUTES * 60 * 1000
        );

        let insert;
        try {
          insert = await client.query<{
            id: string;
            expires_at: Date;
            break_glass: boolean;
            consent_recorded_at: Date | null;
          }>(
            `INSERT INTO impersonation_sessions (
               actor_user_id, target_user_id, target_org_id, reason, audit_id,
               consent_recorded_at, break_glass, expires_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, expires_at, break_glass, consent_recorded_at`,
            [
              admin.userId,
              targetUserId,
              targetOrgId,
              parsed.reason,
              auditId,
              consentAt,
              breakGlass,
              expiresAt.toISOString(),
            ]
          );
        } catch (err) {
          if (isPlatformSchemaMissing(err)) {
            throw Object.assign(
              new Error('impersonation_sessions missing — apply migration 121'),
              { code: 'P503' }
            );
          }
          throw err;
        }

        let sessionEpoch = 0;
        try {
          const ep = await client.query<{ session_epoch: number }>(
            `SELECT session_epoch FROM users WHERE id = $1`,
            [targetUserId]
          );
          sessionEpoch = Number(ep.rows[0]?.session_epoch) || 0;
        } catch (err) {
          if (!isPlatformSchemaMissing(err)) throw err;
          sessionEpoch = 0;
        }

        const row = insert.rows[0];
        return {
          id: row.id,
          expires_at: row.expires_at,
          break_glass: row.break_glass,
          consent_recorded_at: row.consent_recorded_at,
          session_epoch: sessionEpoch,
        } satisfies SessionRow;
      }
    );

    const maxAge = IMPERSONATION_MAX_MINUTES * 60;
    const res = NextResponse.json({
      ok: true,
      impersonationId: session.id,
      targetUserId,
      targetOrgId,
      expiresAt: session.expires_at,
      breakGlass: session.break_glass,
      consentRecordedAt: session.consent_recorded_at,
    });

    // Target session: userId.epoch.sig must match users.session_epoch or
    // getScopedClient rejects. No companion darex_session_epoch cookie.
    await applySessionCookies(res, {
      userId: targetUserId,
      orgId: targetOrgId,
      onboardingComplete: true,
      maxAgeSeconds: maxAge,
      sessionEpoch: session.session_epoch,
    });
    // Value is `${sessionId}.${actorUserId}.${platformRole}` so /end can
    // platform_begin as the original operator after the session becomes the target.
    res.cookies.set(
      IMPERSONATION_COOKIE,
      `${session.id}.${admin.userId}.${admin.platformRole}`,
      {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: 'lax',
        path: '/',
        maxAge,
      }
    );

    return res;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'P404' || code === 'P403') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (code === 'P503') {
      return NextResponse.json(
        {
          error: 'platform_migration_pending',
          message: publicErrorMessage(err, 'migration pending'),
        },
        { status: 503 }
      );
    }
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('POST /api/platform/impersonation', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
