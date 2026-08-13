import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { updatePasswordHash } from '@/lib/auth-user';
import { hashPassword, sha256Hex } from '@/lib/password';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: string; password?: string };
  const token = typeof body.token === 'string' ? body.token : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!token || password.length < 8) {
    return NextResponse.json(
      { status: 'ERROR', message: 'A valid token and password of at least 8 characters are required.' },
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
