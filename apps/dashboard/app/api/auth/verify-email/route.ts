import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { clientIpFromRequest, denyAuthIfLimited } from '@/lib/rate-limit';
import { consumeVerificationToken } from '@/lib/email-verification';
import { lookupUserById } from '@/lib/auth-user';
import { recordAuditEvent } from '@/lib/audit-events';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export async function POST(request: Request) {
  const limited = denyAuthIfLimited(clientIpFromRequest(request), 'reset_password');
  if (limited) return limited;

  const body = (await jsonBodyOrEmpty(request)) as { token?: string };
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) {
    return NextResponse.json({ status: 'ERROR', message: 'A verification token is required.' }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    const result = await consumeVerificationToken(client, token);
    if (!result.ok) {
      return NextResponse.json({ status: 'ERROR', message: 'Invalid or expired verification link.' }, { status: 400 });
    }
    try {
      const user = await lookupUserById(client, result.userId);
      if (user?.org_id) {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [user.org_id]);
        await recordAuditEvent(
          {
            orgId: user.org_id,
            kind: 'register',
            actor: { actorType: 'user', userId: result.userId },
            action: 'auth.email_verified',
            resultStatus: 'ok',
          },
          { client, orgId: user.org_id }
        );
      }
    } catch (auditErr) {
      console.error('[auth] email verification audit failed:', auditErr);
    }
    return NextResponse.json({ status: 'OK' });
  } catch (err) {
    console.error('Verify email error:', err);
    return NextResponse.json({ status: 'ERROR', message: 'Could not verify email.' }, { status: 500 });
  } finally {
    client.release();
  }
}
