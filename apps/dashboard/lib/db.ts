import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { cookies } from 'next/headers';
import { parseSessionCookieParts, SESSION_COOKIE } from '@/lib/session-cookie';
import { attachUserToOrg, lookupUserById } from '@/lib/auth-user';
import { assertProductionBoot, isNextProductionBuild, resolveRuntimeDbUser } from '@/lib/boot-guards';
import {
  kickPeriodicSweeps,
  seedDefaultAutonomyRules,
  seedDefaultEmployees,
  seedOrgCostCeiling,
} from '@/lib/employee-provision';
import {
  assertOrgSessionAllowed,
  type OrgSessionOptions,
} from '@/lib/org-session';

export {
  ORG_SUSPENDED_CODE,
  OrgSuspendedError,
  assertOrgSessionAllowed,
  isOrgSuspendedError,
  scopedAuthErrorResponse,
} from '@/lib/org-session';

export type GetScopedClientOptions = OrgSessionOptions;

function poolOptions(max: number): ConstructorParameters<typeof Pool>[0] {
  assertProductionBoot();
  let password = process.env.APP_DB_PASSWORD || process.env.DB_PASSWORD;
  if (!password) {
    // `next build` imports this module while collecting pages. It has no
    // database. Runtime still refuses to boot without a real password.
    if (isNextProductionBuild()) {
      password = 'unused-during-next-build';
    } else {
      throw new Error('DB_PASSWORD or APP_DB_PASSWORD must be set — no hardcoded fallback.');
    }
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: resolveRuntimeDbUser(),
    password,
    database: process.env.DB_NAME || 'darex',
    max,
    idleTimeoutMillis: max === 1 ? 10000 : 30000,
  };
}

function createPool(): Pool {
  return new Pool(poolOptions(10));
}

/**
 * Reachability probe only. Never sets app.current_org_id and never reads
 * tenant tables. Kept off the request pool so a full max:10 does not hide
 * a database outage or steal the last slot from a tenant request.
 */
function createHealthProbePool(): Pool {
  return new Pool(poolOptions(1));
}

const globalForDb = global as unknown as {
  pool: Pool | undefined;
  healthProbePool: Pool | undefined;
  darexConnectGuarded?: boolean;
};

type DarexScopedClient = PoolClient & {
  _darexScoped?: boolean;
  /** Native pg release — used by releaseScopedClient to avoid re-entering the wrapper. */
  _darexOriginalRelease?: (err?: Error | boolean) => void;
  /** Our wrapper; pg-pool installs a fresh native release on every checkout, so identity tells us if it is stale. */
  _darexWrappedRelease?: PoolClient['release'];
};

export function wrapClientRelease(client: PoolClient): void {
  const marked = client as DarexScopedClient;
  if (marked._darexScoped && client.release === marked._darexWrappedRelease) return;
  marked._darexScoped = true;
  const originalRelease = client.release.bind(client);
  marked._darexOriginalRelease = originalRelease;
  const wrapped = function (err?: Error | boolean) {
    // On error the pool destroys the client — skip RESET, destroy immediately
    // so a poisoned session (failed RESET, bad txn) never gets reused.
    if (err) {
      originalRelease(err);
      return;
    }
    // NOTE: originalRelease is intentionally called only AFTER the RESETs
    // complete. The client stays checked out until then, so the pool cannot
    // hand it to another checkout with a stale app.current_org_id.
    let resetError: unknown = null;
    client
      .query('RESET app.current_org_id')
      .catch((e) => { resetError = e; })
      .then(() => client.query('RESET app.current_user_id'))
      .catch((e) => { resetError = resetError || e; })
      .then(
        () => {
          if (resetError) {
            originalRelease(resetError instanceof Error ? resetError : new Error('Failed to reset session RLS'));
          } else {
            originalRelease();
          }
        },
        (unhandled) => {
          originalRelease(unhandled instanceof Error ? unhandled : new Error('Failed to reset session RLS'));
        }
      );
  } as typeof client.release;
  marked._darexWrappedRelease = wrapped;
  client.release = wrapped;
}

/**
 * Every pool checkout must RESET RLS GUCs on release — including direct
 * `pool.connect()` callers that never go through getScopedClient. Idempotent
 * via `_darexScoped` so getScopedClient / getOrgScopedClient stay safe.
 */
function installPoolConnectGuard(p: Pool): void {
  const originalConnect = p.connect.bind(p) as {
    (): Promise<PoolClient>;
    (
      callback: (err: Error | undefined, client: PoolClient, done: (release?: boolean | Error) => void) => void
    ): void;
  };

  p.connect = function connect(
    callback?: (err: Error | undefined, client: PoolClient, done: (release?: boolean | Error) => void) => void
  ) {
    if (typeof callback === 'function') {
      return originalConnect((err, client, done) => {
        if (client) wrapClientRelease(client);
        callback(err, client, done);
      });
    }
    return originalConnect().then((client) => {
      wrapClientRelease(client);
      return client;
    });
  } as typeof p.connect;
}

export const pool = globalForDb.pool ?? createPool();
export const healthProbePool = globalForDb.healthProbePool ?? createHealthProbePool();

// Always cache — in prod every import otherwise creates a new Pool(max:10)
// and exhausts Postgres.
if (!globalForDb.darexConnectGuarded) {
  installPoolConnectGuard(pool);
  globalForDb.darexConnectGuarded = true;
}
globalForDb.pool = pool;
globalForDb.healthProbePool = healthProbePool;

/**
 * Multi-Tenant Scoped Database Client Helper
 * Ensures 100% strict tenant isolation per user account and organization.
 * Org id comes from the session user only — never from request body/query.
 * Suspended / soft_deleted orgs are refused (402) unless allowSuspended.
 */
export async function getScopedClient(
  options?: GetScopedClientOptions
): Promise<{ client: PoolClient; orgId: string; userId: string; sessionEpoch: number }> {
  const cookieStore = await cookies();
  const session = await parseSessionCookieParts(cookieStore.get(SESSION_COOKIE)?.value);

  if (!session) {
    throw new Error('Unauthorized');
  }
  const { userId, epoch: cookieEpoch } = session;

  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);

    const user = await lookupUserById(client, userId);
    if (!user) {
      throw new Error('Unauthorized');
    }

    let sessionEpoch = 0;
    let disabled = false;
    try {
      const epochRes = await client.query<{ session_epoch: number; disabled: boolean }>(
        `SELECT session_epoch, (disabled_at IS NOT NULL) AS disabled FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      sessionEpoch = Number(epochRes.rows[0]?.session_epoch ?? 0);
      disabled = epochRes.rows[0]?.disabled === true;
    } catch (err: unknown) {
      // Column missing (42703) before migration 121 / 206 — treat as epoch 0, not disabled.
      if ((err as { code?: string })?.code !== '42703') throw err;
      sessionEpoch = 0;
    }
    if (cookieEpoch !== sessionEpoch || disabled) {
      throw new Error('Unauthorized');
    }

    let orgId = user.org_id;
    if (!orgId) {
      orgId = await createOrgForEmail(client, user.email || 'user');
      await attachUserToOrg(client, userId, orgId, 'owner');
    }

    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

    const statusRes = await client.query<{ status: string }>(
      `SELECT status FROM orgs WHERE id = $1 LIMIT 1`,
      [orgId]
    );
    assertOrgSessionAllowed(statusRes.rows[0]?.status, options);

    wrapClientRelease(client);
    return { client, orgId, userId, sessionEpoch };
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

/**
 * Awaitable release for callers that want to guarantee RLS reset before
 * continuing (e.g. tests, webhook batch loops). Normal `client.release()`
 * already resets before returning to the pool; this awaits RESET then calls
 * the native release so we never re-enter the wrapper or clear `_darexScoped`
 * (clearing it would double-wrap on the next pool checkout of the same object).
 */
export async function releaseScopedClient(client: PoolClient): Promise<void> {
  const marked = client as DarexScopedClient;
  const originalRelease =
    marked._darexOriginalRelease ?? (client.release.bind(client) as DarexScopedClient['_darexOriginalRelease']);

  let resetError: unknown = null;
  try {
    await client.query('RESET app.current_org_id');
    await client.query('RESET app.current_user_id');
  } catch (e) {
    resetError = e;
  }

  // Keep `_darexScoped` true so a later wrapClientRelease on pool reuse is a
  // no-op (release stays the existing wrapper; original is still native).
  if (resetError) {
    originalRelease!(resetError instanceof Error ? resetError : new Error('Failed to reset session RLS'));
  } else {
    originalRelease!();
  }
}

/**
 * Create a fresh per-user organization (no shared demo org) and return its id.
 * Used before a user row exists (e.g. registration / OAuth first login).
 */
export async function createOrgForEmail(client: PoolClient, email: string): Promise<string> {
  const name = `${(email || 'user').split('@')[0]}'s Organization`;
  const slug = `org-${(email || 'user').replace(/[^a-z0-9]+/gi, '-').slice(0, 24)}-${Date.now()}`;
  return provisionOrg(client, name, slug);
}

/**
 * Create a named workspace for a user who already exists (workspace switcher).
 * Same provisioning as signup; the caller attaches the user and rotates cookies.
 */
export async function createWorkspaceOrg(client: PoolClient, name: string): Promise<string> {
  const slug = `ws-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${randomUUID().slice(0, 8)}`;
  return provisionOrg(client, name, slug);
}

async function provisionOrg(client: PoolClient, name: string, slug: string): Promise<string> {
  // Generate the id here. INSERT ... RETURNING is checked against the SELECT
  // policy, which requires app.current_org_id to already be this org — so a
  // first-time signup was rejected as an RLS violation on orgs.
  const orgId = randomUUID();
  // SECURITY DEFINER (migration 201): darex_app has no INSERT on orgs, and
  // the function pins plan=free / status=provisioning.
  await client.query(`SELECT auth_create_org($1::uuid, $2::text, $3::text)`, [orgId, name, slug]);
  await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
  wrapClientRelease(client);
  await seedDefaultAutonomyRules(client, orgId);
  await seedOrgCostCeiling(client, orgId);
  await seedDefaultEmployees(client, orgId);
  kickPeriodicSweeps(orgId);
  return orgId;
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
