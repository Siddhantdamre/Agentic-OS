import type { PoolClient } from 'pg';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

export async function isAccountLocked(
  client: PoolClient,
  userId: string
): Promise<{ locked: boolean; lockedUntil: Date | null }> {
  try {
    const res = await client.query<{ locked_until: Date | null }>(
      `SELECT locked_until FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    const until = res.rows[0]?.locked_until ?? null;
    if (until && new Date(until).getTime() > Date.now()) {
      return { locked: true, lockedUntil: until };
    }
    return { locked: false, lockedUntil: null };
  } catch (err: unknown) {
    // Column may not exist until migration 097
    if ((err as { code?: string })?.code === '42703') {
      return { locked: false, lockedUntil: null };
    }
    throw err;
  }
}

export async function recordFailedLogin(client: PoolClient, userId: string): Promise<void> {
  try {
    await client.query(
      `UPDATE users
       SET failed_login_count = COALESCE(failed_login_count, 0) + 1,
           locked_until = CASE
             WHEN COALESCE(failed_login_count, 0) + 1 >= $2
             THEN NOW() + ($3::text || ' minutes')::interval
             ELSE locked_until
           END,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, LOCKOUT_THRESHOLD, String(LOCKOUT_MINUTES)]
    );
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42703') return;
    throw err;
  }
}

export async function clearFailedLogins(client: PoolClient, userId: string): Promise<void> {
  try {
    await client.query(
      `UPDATE users
       SET failed_login_count = 0, locked_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42703') return;
    throw err;
  }
}

export async function loadTotpState(
  client: PoolClient,
  userId: string
): Promise<{ enabled: boolean; secret: string | null }> {
  try {
    const res = await client.query<{ totp_enabled: boolean; totp_secret: string | null }>(
      `SELECT totp_enabled, totp_secret FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    return {
      enabled: Boolean(res.rows[0]?.totp_enabled),
      secret: res.rows[0]?.totp_secret ?? null,
    };
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42703') {
      return { enabled: false, secret: null };
    }
    throw err;
  }
}

export async function upsertOrgMembership(
  client: PoolClient,
  userId: string,
  orgId: string,
  role: string,
  isDefault = false
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO organization_memberships (user_id, org_id, role, is_default)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, org_id) DO UPDATE SET
         role = EXCLUDED.role,
         is_default = organization_memberships.is_default OR EXCLUDED.is_default,
         updated_at = NOW()`,
      [userId, orgId, role, isDefault]
    );
  } catch (err: unknown) {
    // Table may not exist until migration 097
    if ((err as { code?: string })?.code === '42P01') return;
    throw err;
  }
}
