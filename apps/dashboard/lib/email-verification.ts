/**
 * Email verification for password signups.
 * Enforcement is opt-in (REQUIRE_EMAIL_VERIFICATION=true) and only gates the
 * password login path; OAuth/SSO identities are verified by their provider.
 * Before migration 209 every check degrades to "verified" instead of erroring.
 */
import type { PoolClient } from 'pg';
import { randomToken, sha256Hex } from '@/lib/password';
import { appBaseUrl, sendTransactionalEmail } from '@/lib/mail';

export function emailVerificationRequired(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION === 'true';
}

function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === '42883' || code === '42P01' || code === '42703';
}

export async function isEmailVerified(client: PoolClient, userId: string): Promise<boolean> {
  try {
    const res = await client.query<{ v: boolean }>(`SELECT auth_is_email_verified($1) AS v`, [userId]);
    return res.rows[0]?.v === true;
  } catch (err) {
    if (isMissingSchema(err)) return true;
    throw err;
  }
}

export async function markEmailVerified(client: PoolClient, userId: string): Promise<void> {
  try {
    await client.query(`SELECT auth_mark_email_verified($1)`, [userId]);
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
  }
}

/**
 * Create a token for an unverified account and email the link. Returns the
 * user id when a token was issued, null when the account is missing/verified.
 */
export async function sendVerificationEmail(
  client: PoolClient,
  email: string
): Promise<string | null> {
  const token = randomToken();
  let userId: string | null;
  try {
    const res = await client.query<{ id: string | null }>(
      `SELECT auth_create_email_verification($1, $2, NOW() + INTERVAL '24 hours') AS id`,
      [email, sha256Hex(token)]
    );
    userId = res.rows[0]?.id ?? null;
  } catch (err) {
    if (isMissingSchema(err)) return null;
    throw err;
  }
  if (!userId) return null;
  const url = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  const mail = await sendTransactionalEmail({
    to: email,
    subject: 'Verify your Darex email',
    text: `Confirm your email address using this link (expires in 24 hours):\n${url}`,
  });
  if (!mail.sent && process.env.NODE_ENV !== 'production') {
    console.info('[auth] email verification URL:', url);
  }
  return userId;
}

export type VerifyResult = { ok: true; userId: string } | { ok: false };

export async function consumeVerificationToken(client: PoolClient, token: string): Promise<VerifyResult> {
  try {
    const res = await client.query<{ id: string | null }>(
      `SELECT auth_consume_email_verification($1) AS id`,
      [sha256Hex(token)]
    );
    const userId = res.rows[0]?.id;
    return userId ? { ok: true, userId } : { ok: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/VERIFY_(NOT_FOUND|EXPIRED|ALREADY_USED)/.test(msg)) return { ok: false };
    throw err;
  }
}
