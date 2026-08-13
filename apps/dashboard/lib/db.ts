import { Pool, PoolClient } from 'pg';
import { cookies } from 'next/headers';
import { parseSessionCookie, SESSION_COOKIE } from '@/lib/session-cookie';
import { attachUserToOrg, lookupUserById } from '@/lib/auth-user';

function readEnv(key: string): string | undefined {
  return process.env[key];
}

function createPool(): Pool {
  const isProd = readEnv('NODE_ENV') === 'production';
  // `next build` sets NODE_ENV=production while collecting page data. That is
  // not a running app — Docker/CI must compile without runtime DB secrets.
  const isNextBuild = readEnv('NEXT_PHASE') === 'phase-production-build';
  if (isProd && !isNextBuild && !readEnv('DB_PASSWORD')) {
    throw new Error('DB_PASSWORD must be set in production');
  }
  if (isProd && !isNextBuild && !readEnv('DB_HOST')) {
    throw new Error('DB_HOST must be set in production');
  }
  return new Pool({
    host: readEnv('DB_HOST') || 'localhost',
    port: parseInt(readEnv('DB_PORT') || '5432', 10),
    user: readEnv('DB_USER') || 'darex_app',
    password: readEnv('DB_PASSWORD'),
    database: readEnv('DB_NAME') || 'darex',
    max: 10,
    idleTimeoutMillis: 30000,
  });
}

const globalForDb = global as unknown as { pool: Pool };

export const pool = globalForDb.pool || createPool();

if (process.env.NODE_ENV !== 'production') globalForDb.pool = pool;

/**
 * Multi-Tenant Scoped Database Client Helper
 * Ensures 100% strict tenant isolation per user account and organization.
 */
export async function getScopedClient(): Promise<{ client: PoolClient; orgId: string; userId: string }> {
  const cookieStore = await cookies();
  const userId = await parseSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);

  if (!userId) {
    throw new Error('Unauthorized');
  }

  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);

    const user = await lookupUserById(client, userId);
    if (!user) {
      throw new Error('Unauthorized');
    }

    let orgId = user.org_id;
    if (!orgId) {
      orgId = await createOrgForEmail(client, user.email || 'user');
      await attachUserToOrg(client, userId, orgId, 'owner');
    }

    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    wrapClientRelease(client);
    return { client, orgId, userId };
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Scope a pooled client to an org that was already resolved (webhooks, background
 * agent follow-up). Session-level RLS, reset on release. Never takes org_id from
 * an untrusted request body — the caller must resolve tenant first.
 */
export async function getOrgScopedClient(orgId: string): Promise<{ client: PoolClient; orgId: string }> {
  if (!orgId) {
    throw new Error('orgId is required');
  }
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    wrapClientRelease(client);
    return { client, orgId };
  } catch (err) {
    client.release();
    throw err;
  }
}

function wrapClientRelease(client: PoolClient): void {
  const marked = client as PoolClient & { _darexScoped?: boolean };
  if (marked._darexScoped) return;
  marked._darexScoped = true;
  const originalRelease = client.release.bind(client);
  client.release = function (err?: Error | boolean) {
    const finish = () => originalRelease(err);
    client
      .query('RESET app.current_org_id')
      .catch(() => undefined)
      .then(() => client.query('RESET app.current_user_id'))
      .catch(() => undefined)
      .then(finish, finish);
  } as typeof client.release;
}

/**
 * Create a fresh per-user organization (no shared demo org) and return its id.
 * Used before a user row exists (e.g. registration / OAuth first login).
 */
export async function createOrgForEmail(client: PoolClient, email: string): Promise<string> {
  const name = `${(email || 'user').split('@')[0]}'s Organization`;
  const slug = `org-${(email || 'user').replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${Date.now()}`;
  const res = await client.query(
    `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'starter', 'provisioning') RETURNING id`,
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
  const user = await lookupUserById(client, userId);
  const existing = user?.org_id;
  if (existing) return existing;

  const orgId = await createOrgForEmail(client, email);
  await attachUserToOrg(client, userId, orgId, 'owner');
  return orgId;
}
