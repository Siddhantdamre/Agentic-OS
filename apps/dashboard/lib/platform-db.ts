/**
 * Platform admin DB pool (`darex_platform`) + audited cross-org transactions.
 *
 * Never fall back to the `darex` superuser, never SET row_security = off,
 * and never use getScopedClient() to read another org. Cross-org work runs
 * only after platform_begin(...) in the same transaction.
 */
import { Pool, PoolClient } from 'pg';
import { isNextProductionBuild, isProductionEnv } from '@/lib/boot-guards';

export const PLATFORM_DB_UNCONFIGURED = 'platform_db_unconfigured';
export const PLATFORM_MIGRATION_PENDING = 'platform_migration_pending';

const SUPERUSER_DB_USERS = new Set(['darex', 'postgres']);

export type PlatformRole = 'operator' | 'support';

export type PlatformBeginArgs = {
  actorUserId: string;
  platformRole: PlatformRole;
  action: string;
  targetOrgId?: string | null;
  targetTable?: string | null;
  targetRowId?: string | null;
  reason: string;
};

export class PlatformDbError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 503) {
    super(message);
    this.name = 'PlatformDbError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return undefined;
}

/** Missing relation (42P01) or column (42703) — migrations 116–121 not applied. */
export function isPlatformSchemaMissing(err: unknown): boolean {
  const code = pgCode(err);
  return code === '42P01' || code === '42703';
}

export function isUndefinedFunction(err: unknown): boolean {
  return pgCode(err) === '42883';
}

export function platformMigrationResponse(err?: unknown): Response {
  const detail =
    err instanceof Error ? err.message.slice(0, 200) : 'platform schema missing';
  return Response.json(
    {
      error: PLATFORM_MIGRATION_PENDING,
      message: 'Platform migration is not applied',
      detail,
    },
    { status: 503 }
  );
}

export function platformUnconfiguredResponse(): Response {
  return Response.json(
    {
      error: PLATFORM_DB_UNCONFIGURED,
      message:
        'Platform database role is not configured. Set DAREX_PLATFORM_DATABASE_URL or DAREX_PLATFORM_DB_USER=darex_platform with a password.',
    },
    { status: 503 }
  );
}

type PlatformPoolConfig = {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};

/**
 * Resolve platform pool options. Returns null when the platform role is not
 * configured — callers must 503 rather than query as darex_app.
 */
export function resolvePlatformPoolConfig(): PlatformPoolConfig | null {
  const url = process.env.DAREX_PLATFORM_DATABASE_URL?.trim();
  if (url) {
    try {
      const parsed = new URL(url);
      const user = decodeURIComponent(parsed.username || '');
      if (!user || SUPERUSER_DB_USERS.has(user)) {
        throw new PlatformDbError(
          PLATFORM_DB_UNCONFIGURED,
          `DAREX_PLATFORM_DATABASE_URL must use user darex_platform (got ${user || 'empty'})`,
          503
        );
      }
      if (user !== 'darex_platform') {
        throw new PlatformDbError(
          PLATFORM_DB_UNCONFIGURED,
          `DAREX_PLATFORM_DATABASE_URL user must be darex_platform (got ${user})`,
          503
        );
      }
    } catch (err) {
      if (err instanceof PlatformDbError) throw err;
      // Non-URL connection strings (e.g. key=value) — still accept; pg validates.
    }
    return { connectionString: url };
  }

  const user = (process.env.DAREX_PLATFORM_DB_USER || '').trim();
  if (!user) return null;
  if (SUPERUSER_DB_USERS.has(user)) {
    throw new PlatformDbError(
      PLATFORM_DB_UNCONFIGURED,
      `DAREX_PLATFORM_DB_USER must not be superuser ${user}`,
      503
    );
  }
  if (user !== 'darex_platform') {
    throw new PlatformDbError(
      PLATFORM_DB_UNCONFIGURED,
      `DAREX_PLATFORM_DB_USER must be darex_platform (got ${user})`,
      503
    );
  }

  let password =
    process.env.DAREX_PLATFORM_DB_PASSWORD ||
    process.env.APP_DB_PASSWORD ||
    process.env.DB_PASSWORD;
  if (!password) {
    if (isNextProductionBuild()) {
      password = 'unused-during-next-build';
    } else if (isProductionEnv()) {
      throw new PlatformDbError(
        PLATFORM_DB_UNCONFIGURED,
        'DAREX_PLATFORM_DB_PASSWORD (or DB_PASSWORD) must be set for darex_platform',
        503
      );
    } else {
      return null;
    }
  }

  return {
    host: process.env.DAREX_PLATFORM_DB_HOST || process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DAREX_PLATFORM_DB_PORT || process.env.DB_PORT || '5432', 10),
    user: 'darex_platform',
    password,
    database: process.env.DAREX_PLATFORM_DB_NAME || process.env.DB_NAME || 'darex',
  };
}

export function isPlatformDbConfigured(): boolean {
  try {
    return resolvePlatformPoolConfig() !== null;
  } catch {
    return false;
  }
}

const globalForPlatform = global as unknown as {
  darexPlatformPool?: Pool;
};

function createPlatformPool(): Pool {
  const cfg = resolvePlatformPoolConfig();
  if (!cfg) {
    throw new PlatformDbError(
      PLATFORM_DB_UNCONFIGURED,
      'Platform database role is not configured',
      503
    );
  }
  if (cfg.connectionString) {
    return new Pool({ connectionString: cfg.connectionString, max: 5, idleTimeoutMillis: 30000 });
  }
  return new Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

export function getPlatformPool(): Pool {
  if (!globalForPlatform.darexPlatformPool) {
    globalForPlatform.darexPlatformPool = createPlatformPool();
  }
  return globalForPlatform.darexPlatformPool;
}

/**
 * Insert admin_audit_log + set app.platform_audit_id for this transaction.
 * Must run as darex_platform. Missing function → 503 migration pending.
 */
export async function platformBegin(
  client: PoolClient,
  args: PlatformBeginArgs
): Promise<string> {
  try {
    const res = await client.query<{ platform_begin: string }>(
      `SELECT platform_begin($1::uuid, $2::text, $3::text, $4::uuid, $5::text, $6::text, $7::text) AS platform_begin`,
      [
        args.actorUserId,
        args.platformRole,
        args.action,
        args.targetOrgId ?? null,
        args.targetTable ?? null,
        args.targetRowId ?? null,
        args.reason,
      ]
    );
    const id = res.rows[0]?.platform_begin;
    if (!id) {
      throw new PlatformDbError(
        PLATFORM_MIGRATION_PENDING,
        'platform_begin returned no audit id',
        503
      );
    }
    return id;
  } catch (err) {
    if (isUndefinedFunction(err) || isPlatformSchemaMissing(err)) {
      throw new PlatformDbError(
        PLATFORM_MIGRATION_PENDING,
        'platform_begin is not available — apply migration 119',
        503
      );
    }
    throw err;
  }
}

/**
 * Run work inside a darex_platform transaction after platform_begin.
 * Commits on success, rolls back on error. Always releases the client.
 */
export async function withPlatformTransaction<T>(
  begin: PlatformBeginArgs,
  work: (client: PoolClient, auditId: string) => Promise<T>
): Promise<T> {
  if (!isPlatformDbConfigured()) {
    throw new PlatformDbError(
      PLATFORM_DB_UNCONFIGURED,
      'Platform database role is not configured',
      503
    );
  }

  let client: PoolClient;
  try {
    client = await getPlatformPool().connect();
  } catch (err) {
    if (err instanceof PlatformDbError) throw err;
    throw new PlatformDbError(
      PLATFORM_DB_UNCONFIGURED,
      err instanceof Error ? err.message : 'Failed to connect platform pool',
      503
    );
  }

  try {
    await client.query('BEGIN');
    const auditId = await platformBegin(client, begin);
    const result = await work(client, auditId);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    if (isPlatformSchemaMissing(err) || isUndefinedFunction(err)) {
      throw new PlatformDbError(
        PLATFORM_MIGRATION_PENDING,
        'Platform migration is not applied',
        503
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

export function platformErrorResponse(err: unknown): Response | null {
  if (err instanceof PlatformDbError) {
    if (err.code === PLATFORM_DB_UNCONFIGURED) return platformUnconfiguredResponse();
    if (err.code === PLATFORM_MIGRATION_PENDING) return platformMigrationResponse(err);
    return Response.json({ error: err.code, message: err.message }, { status: err.httpStatus });
  }
  if (isPlatformSchemaMissing(err) || isUndefinedFunction(err)) {
    return platformMigrationResponse(err);
  }
  return null;
}
