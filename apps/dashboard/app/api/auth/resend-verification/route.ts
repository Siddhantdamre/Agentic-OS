import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { isValidEmail, normalizeEmail } from '@/lib/password';
import { clientIpFromRequest, denyAuthIfLimited } from '@/lib/rate-limit';
import { sendVerificationEmail } from '@/lib/email-verification';

/** Always answers OK so the response never reveals whether an account exists. */
export async function POST(request: Request) {
  const ip = clientIpFromRequest(request);
  const limited = denyAuthIfLimited(ip, 'forgot_password');
  if (limited) return limited;

  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  if (!email || !isValidEmail(email)) return NextResponse.json({ status: 'OK' });

  const emailLimited = denyAuthIfLimited(`email:${email}`, 'forgot_password');
  if (emailLimited) return emailLimited;

  const client = await pool.connect();
  try {
    await sendVerificationEmail(client, email);
  } catch (err) {
    console.error('Resend verification error:', err);
  } finally {
    client.release();
  }
  return NextResponse.json({ status: 'OK' });
}
