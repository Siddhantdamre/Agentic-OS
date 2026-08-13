import type { PoolClient } from 'pg';
import { sha256Hex } from '@/lib/password';

export type AuthUserRow = {
  id: string;
  org_id: string | null;
  email: string;
  role: string;
  password_hash: string | null;
  supertokens_id: string | null;
};

function isUndefinedFunction(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '42883';
}

export async function lookupUserByEmail(client: PoolClient, email: string): Promise<AuthUserRow | null> {
  try {
    const res = await client.query<AuthUserRow>(
      `SELECT id, org_id, email, role, password_hash, supertokens_id FROM auth_lookup_user_by_email($1)`,
      [email]
    );
    return res.rows[0] ?? null;
  } catch (err) {
    if (!isUndefinedFunction(err)) throw err;
    const res = await client.query<AuthUserRow>(
      `SELECT id, org_id, email, role, password_hash, supertokens_id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );
    return res.rows[0] ?? null;
  }
}

export async function lookupUserById(client: PoolClient, userId: string): Promise<AuthUserRow | null> {
  try {
    const res = await client.query<AuthUserRow>(
      `SELECT id, org_id, email, role, password_hash, supertokens_id FROM auth_lookup_user_by_id($1::uuid)`,
      [userId]
    );
    return res.rows[0] ?? null;
  } catch (err) {
    if (!isUndefinedFunction(err)) throw err;
    await client.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);
    const res = await client.query<AuthUserRow>(
      `SELECT id, org_id, email, role, password_hash, supertokens_id FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    return res.rows[0] ?? null;
  }
}

export async function insertAuthUser(
  client: PoolClient,
  opts: {
    orgId: string;
    email: string;
    role: string;
    supertokensId: string;
    passwordHash: string | null;
  }
): Promise<string> {
  try {
    const res = await client.query<{ auth_insert_user: string }>(
      `SELECT auth_insert_user($1::uuid, $2, $3, $4, $5) AS auth_insert_user`,
      [opts.orgId, opts.email, opts.role, opts.supertokensId, opts.passwordHash]
    );
    return res.rows[0].auth_insert_user;
  } catch (err) {
    if (!isUndefinedFunction(err)) throw err;
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [opts.orgId]);
    const insertRes = await client.query<{ id: string }>(
      `INSERT INTO users (org_id, email, role, supertokens_id, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (supertokens_id) DO UPDATE
         SET email = EXCLUDED.email,
             password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash)
       RETURNING id`,
      [opts.orgId, opts.email, opts.role, opts.supertokensId, opts.passwordHash]
    );
    await client
      .query(
        `INSERT INTO org_onboarding (org_id, wizard_step) VALUES ($1, 'name') ON CONFLICT (org_id) DO NOTHING`,
        [opts.orgId]
      )
      .catch(() => {});
    return insertRes.rows[0].id;
  }
}

export async function attachUserToOrg(
  client: PoolClient,
  userId: string,
  orgId: string,
  role?: string
): Promise<void> {
  try {
    await client.query(`SELECT auth_attach_user_to_org($1::uuid, $2::uuid, $3)`, [userId, orgId, role ?? null]);
  } catch (err) {
    if (!isUndefinedFunction(err)) throw err;
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    await client.query(`UPDATE users SET org_id = $1, role = COALESCE($2, role) WHERE id = $3`, [
      orgId,
      role ?? null,
      userId,
    ]);
  }
}

export async function updatePasswordHash(client: PoolClient, userId: string, passwordHash: string): Promise<void> {
  try {
    await client.query(`SELECT auth_update_password_hash($1::uuid, $2)`, [userId, passwordHash]);
  } catch (err) {
    if (!isUndefinedFunction(err)) throw err;
    await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
  }
}

export async function linkSuperTokensId(client: PoolClient, userId: string, supertokensId: string): Promise<void> {
  try {
    await client.query(`SELECT auth_link_supertokens_id($1::uuid, $2)`, [userId, supertokensId]);
  } catch (err) {
    if (!isUndefinedFunction(err)) throw err;
    await client.query(
      `UPDATE users SET supertokens_id = $1 WHERE id = $2 AND (supertokens_id IS NULL OR supertokens_id IS DISTINCT FROM $1)`,
      [supertokensId, userId]
    );
  }
}

export type InviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: string;
  org_name: string;
  expires_at: Date;
  accepted_at: Date | null;
};

export async function lookupInviteByToken(client: PoolClient, rawToken: string): Promise<InviteRow | null> {
  const tokenHash = sha256Hex(rawToken);
  try {
    const res = await client.query<InviteRow>(
      `SELECT id, org_id, email, role, org_name, expires_at, accepted_at
       FROM auth_lookup_invite_by_token_hash($1)`,
      [tokenHash]
    );
    return res.rows[0] ?? null;
  } catch (err) {
    if (!isUndefinedFunction(err)) throw err;
    return null;
  }
}

export async function acceptInviteToken(
  client: PoolClient,
  rawToken: string,
  userId: string
): Promise<{ orgId: string; role: string }> {
  const tokenHash = sha256Hex(rawToken);
  const res = await client.query<{ org_id: string; role: string }>(
    `SELECT org_id, role FROM auth_accept_invite($1, $2::uuid)`,
    [tokenHash, userId]
  );
  if (!res.rows[0]) {
    throw new Error('INVITE_NOT_FOUND');
  }
  return { orgId: res.rows[0].org_id, role: res.rows[0].role };
}

export async function isOnboardingComplete(client: PoolClient, orgId: string): Promise<boolean> {
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    const res = await client.query<{ provisioning_completed_at: Date | null }>(
      `SELECT provisioning_completed_at FROM org_onboarding WHERE org_id = $1 LIMIT 1`,
      [orgId]
    );
    if (res.rows.length === 0) return true;
    return res.rows[0].provisioning_completed_at != null;
  } catch {
    return true;
  }
}

export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code: string }).code;
  }
  return undefined;
}

export function pgErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
