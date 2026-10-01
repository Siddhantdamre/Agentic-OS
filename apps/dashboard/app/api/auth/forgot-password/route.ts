import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { isValidEmail, normalizeEmail, randomToken, sha256Hex } from '@/lib/password';
import { appBaseUrl, sendTransactionalEmail } from '@/lib/mail';
import { clientIpFromRequest, denyAuthIfLimited } from '@/lib/rate-limit';
import { lookupUserById } from '@/lib/auth-user';
import { recordAuditEvent } from '@/lib/audit-events';

export async function POST(request: Request) {
  const limited = denyAuthIfLimited(clientIpFromRequest(request), 'forgot_password');
  if (limited) return limited;

  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';

  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ status: 'OK' });
  }

  const token = randomToken();
  const tokenHash = sha256Hex(token);
  const client = await pool.connect();
  try {
    const res = await client.query<{ auth_create_password_reset: string | null }>(
      `SELECT auth_create_password_reset($1, $2, NOW() + INTERVAL '1 hour') AS auth_create_password_reset`,
      [email, tokenHash]
    );
    const resetUserId = res.rows[0]?.auth_create_password_reset;
    if (resetUserId) {
      // Audit the request (never the token). Only when an account exists; the
      // response stays identical either way so existence is not leaked.
      try {
        const user = await lookupUserById(client, resetUserId);
        if (user?.org_id) {
          await client.query("SELECT set_config('app.current_org_id', $1, false)", [user.org_id]);
          await recordAuditEvent(
            {
              orgId: user.org_id,
              kind: 'password.reset',
              actor: { actorType: 'user', userId: resetUserId },
              action: 'password.reset_requested',
              resultStatus: 'ok',
              riskClass: 'medium',
              payload: { ip: clientIpFromRequest(request) },
            },
            { client, orgId: user.org_id }
          );
        }
      } catch (auditErr) {
        console.error('[auth] password reset request audit failed:', auditErr);
      }
      const resetUrl = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
      const mail = await sendTransactionalEmail({
        to: email,
        subject: 'Reset your Darex password',
        text: `Reset your password using this link (expires in 1 hour):\n${resetUrl}`,
      });
      if (!mail.sent && process.env.NODE_ENV !== 'production') {
        console.info('[auth] password reset URL:', resetUrl);
      }
    }
  } catch (err) {
    console.warn('Forgot-password lookup failed:', err);
  } finally {
    client.release();
  }

  return NextResponse.json({ status: 'OK' });
}
