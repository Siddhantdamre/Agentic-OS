import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { updatePasswordHash } from '@/lib/auth-user';
import { hashPassword, passwordLengthError, sha256Hex } from '@/lib/password';
import { clientIpFromRequest, denyAuthIfLimited } from '@/lib/rate-limit';
import { lookupUserById } from '@/lib/auth-user';
import { recordAuditEvent } from '@/lib/audit-events';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export async function POST(request: Request) {
  const limited = denyAuthIfLimited(clientIpFromRequest(request), 'reset_password');
  if (limited) return limited;

  const body = (await jsonBodyOrEmpty(request)) as { token?: string; password?: string };
  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const lengthError = passwordLengthError(password);
  if (!token || lengthError) {
    return NextResponse.json(
      {
        status: 'ERROR',
        message: lengthError || 'A valid token and password of at least 8 characters are required.',
      },
      { status: 400 }
    );
  }

  const tokenHash = sha256Hex(token);
  const client = await pool.connect();
  try {
    const consumed = await client.query<{ auth_consume_password_reset: string }>(
      `SELECT auth_consume_password_reset($1) AS auth_consume_password_reset`,
      [tokenHash]
    );
    const userId = consumed.rows[0]?.auth_consume_password_reset;
    if (!userId) {
      return NextResponse.json({ status: 'ERROR', message: 'Invalid or expired reset link.' }, { status: 400 });
    }
    await updatePasswordHash(client, userId, hashPassword(password));
    try {
      await client.query(
        `UPDATE users SET password_changed_at = NOW(), session_epoch = COALESCE(session_epoch, 0) + 1, failed_login_count = 0, locked_until = NULL WHERE id = $1`,
        [userId]
      );
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== '42703') throw err;
    }
    try {
      const user = await lookupUserById(client, userId);
      if (user?.org_id) {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [user.org_id]);
        await recordAuditEvent(
          {
            orgId: user.org_id,
            kind: 'password.reset',
            actor: { actorType: 'user', userId },
            action: 'password.reset_completed',
            resultStatus: 'ok',
            riskClass: 'high',
            payload: { sessionsRevoked: true, ip: clientIpFromRequest(request) },
          },
          { client, orgId: user.org_id }
        );
      }
    } catch (auditErr) {
      console.error('[auth] password reset consume audit failed:', auditErr);
    }
    return NextResponse.json({ status: 'OK' });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (
      message.includes('RESET_NOT_FOUND') ||
      message.includes('RESET_EXPIRED') ||
      message.includes('RESET_ALREADY_USED')
    ) {
      return NextResponse.json({ status: 'ERROR', message: 'Invalid or expired reset link.' }, { status: 400 });
    }
    console.error('Reset password error:', err);
    return NextResponse.json({ status: 'ERROR', message: 'Could not reset password.' }, { status: 500 });
  } finally {
    client.release();
  }
}
