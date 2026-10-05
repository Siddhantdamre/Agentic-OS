import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import { buildOtpAuthUrl, generateTotpSecret, verifyTotpCode } from '@/lib/totp';
import { loadTotpState } from '@/lib/auth-security';
import { recordAuditEvent } from '@/lib/audit-events';
import { denyAuthIfLimited, clientIpFromRequest } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/** GET: MFA status for the session user (never returns the secret once enabled). */
export async function GET() {
  try {
    const { client, userId } = await getScopedClient();
    try {
      const state = await loadTotpState(client, userId);
      return NextResponse.json({
        enabled: state.enabled,
        configured: Boolean(state.secret),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/auth/mfa Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST actions:
 *  - setup: mint a new secret + otpauth URL (not enabled until confirm)
 *  - confirm: verify code and enable TOTP
 *  - disable: verify code and disable
 */
export async function POST(request: Request) {
  const limited = denyAuthIfLimited(clientIpFromRequest(request), 'login', 'Too many MFA attempts.');
  if (limited) return limited;

  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const body = await tryReadJson<Record<string, unknown>>(request);
      if (!body) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      if (body.orgId || body.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }

      const action = typeof body.action === 'string' ? body.action : '';
      const code = typeof body.code === 'string' ? body.code : '';

      if (action === 'setup') {
        const secret = generateTotpSecret();
        const emailRes = await client.query<{ email: string }>(
          `SELECT email FROM users WHERE id = $1 LIMIT 1`,
          [userId]
        );
        const email = emailRes.rows[0]?.email || 'user';
        try {
          await client.query(
            `UPDATE users
             SET totp_secret = $1, totp_enabled = false, totp_confirmed_at = NULL, updated_at = NOW()
             WHERE id = $2`,
            [secret, userId]
          );
        } catch (err: unknown) {
          if ((err as { code?: string })?.code === '42703') {
            return NextResponse.json(
              { error: 'MFA schema not migrated yet (run migration 097)' },
              { status: 501 }
            );
          }
          throw err;
        }
        return NextResponse.json({
          status: 'OK',
          secret,
          otpauthUrl: buildOtpAuthUrl({ secret, email }),
          enabled: false,
        });
      }

      if (action === 'confirm') {
        const state = await loadTotpState(client, userId);
        if (!state.secret) {
          return NextResponse.json({ error: 'Call setup first' }, { status: 400 });
        }
        if (!verifyTotpCode(state.secret, code)) {
          return NextResponse.json({ error: 'Invalid authenticator code' }, { status: 401 });
        }
        await client.query(
          `UPDATE users
           SET totp_enabled = true, totp_confirmed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [userId]
        );
        await recordAuditEvent(
          {
            orgId,
            kind: 'mfa.enable',
            actor: { actorType: 'user', userId },
            action: 'mfa.enable',
            resultStatus: 'ok',
          },
          { client, orgId }
        ).catch(() => undefined);
        return NextResponse.json({ status: 'OK', enabled: true });
      }

      if (action === 'disable') {
        const state = await loadTotpState(client, userId);
        if (state.enabled && state.secret && !verifyTotpCode(state.secret, code)) {
          return NextResponse.json({ error: 'Invalid authenticator code' }, { status: 401 });
        }
        await client.query(
          `UPDATE users
           SET totp_enabled = false, totp_secret = NULL, totp_confirmed_at = NULL, updated_at = NOW()
           WHERE id = $1`,
          [userId]
        );
        await recordAuditEvent(
          {
            orgId,
            kind: 'mfa.disable',
            actor: { actorType: 'user', userId },
            action: 'mfa.disable',
            resultStatus: 'ok',
          },
          { client, orgId }
        ).catch(() => undefined);
        return NextResponse.json({ status: 'OK', enabled: false });
      }

      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('POST /api/auth/mfa', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
