import { Pool, PoolClient } from 'pg';
import { cookies } from 'next/headers';

const globalForDb = global as unknown as { pool: Pool };

export const pool =
  globalForDb.pool ||
  new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'darex',
    password: process.env.DB_PASSWORD, // Must be set — no insecure hardcoded fallback
    database: process.env.DB_NAME || 'darex',
    max: 10,
    idleTimeoutMillis: 30000,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.pool = pool;

/**
 * Multi-Tenant Scoped Database Client Helper
 * Ensures 100% strict tenant isolation per user account and organization.
 */
export async function getScopedClient(): Promise<{ client: PoolClient; orgId: string; userId: string }> {
  const cookieStore = await cookies();
  const userId = cookieStore.get('darex_session')?.value;

  if (!userId) {
    throw new Error('Unauthorized');
  }

  const client = await pool.connect();
  try {
    // 1. Resolve user's explicit org_id from users table
    const userRes = await client.query('SELECT org_id, email FROM users WHERE id = $1', [userId]);

    if (userRes.rows.length === 0) {
      throw new Error('Unauthorized');
    }

    let orgId = userRes.rows[0]?.org_id;
    const userEmail = userRes.rows[0]?.email || 'user';

    // 2. If user doesn't have a dedicated organization, create one dynamically
    if (!orgId) {
      const orgName = `${userEmail.split('@')[0]}'s Organization`;
      const orgSlug = `org-${userId.slice(0, 8)}`;
      const newOrgRes = await client.query(
        `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'pro', 'active') RETURNING id`,
        [orgName, orgSlug]
      );
      orgId = newOrgRes.rows[0].id;
      await client.query('UPDATE users SET org_id = $1 WHERE id = $2', [orgId, userId]);
    }

    // 3. Set PostgreSQL RLS Context — SESSION-level (`is_local=false`) so the
    //    org binding survives the caller's own autocommit queries (SET LOCAL
    //    with `true` only lasted for the single statement that set it, which
    //    made RLS a no-op). The client is wrapped so `release()` resets the
    //    context, keeping it from leaking to the next pooled borrower.
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

    const scopedClient = client;
    const originalRelease = scopedClient.release.bind(scopedClient);
    scopedClient.release = function (err?: Error | boolean) {
      scopedClient
        .query('RESET app.current_org_id')
        .catch(() => {})
        .finally(() => originalRelease(err));
    } as typeof scopedClient.release;

    return { client: scopedClient, orgId, userId };
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Create a fresh per-user organization (no shared demo org) and return its id.
 * Used before a user row exists (e.g. registration / OAuth first login).
 */
export async function createOrgForEmail(client: PoolClient, email: string): Promise<string> {
  const name = `${(email || 'user').split('@')[0]}'s Organization`;
  const slug = `org-${(email || 'user').replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${Date.now()}`;
  const res = await client.query(
    `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'pro', 'active') RETURNING id`,
    [name, slug]
  );
  return res.rows[0].id;
}

/**
 * Ensure a user is attached to their own organization (never a shared demo org).
 * Returns the existing org if already set, otherwise creates one and links it.
 */
export async function ensureUserOrg(
  client: PoolClient,
  userId: string,
  email: string
): Promise<string> {
  const userRes = await client.query('SELECT org_id FROM users WHERE id = $1', [userId]);
  const existing = userRes.rows[0]?.org_id;
  if (existing) return existing;

  const orgId = await createOrgForEmail(client, email);
  await client.query('UPDATE users SET org_id = $1 WHERE id = $2', [orgId, userId]);
  return orgId;
}
