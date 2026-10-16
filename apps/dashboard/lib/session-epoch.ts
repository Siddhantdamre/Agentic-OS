/**
 * Server-side session epoch: read users.session_epoch and mint cookies that
 * carry it. Node only (uses pg) — middleware must not import this.
 *
 * Every login / OAuth / SSO / invite / org-create path mints through
 * issueSessionCookies() so a revoke (epoch bump) never leaves a user with a
 * cookie that can never match again.
 */
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db';
import {
  applySessionCookies,
  parseSessionCookieParts,
  type ParsedSessionCookie,
} from '@/lib/session-cookie';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Current users.session_epoch. Uses its own pooled connection scoped to the
 * user (users_self_select), so it works before any org context exists.
 * Throws if the user row is missing or the user is disabled — callers must not mint for either.
 */
export async function readSessionEpoch(userId: string, db?: Queryable): Promise<number> {
  const run = async (q: Queryable) => {
    await q.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);
    let row: { session_epoch: number | null; disabled?: boolean } | undefined;
    try {
      const res = await q.query<{ session_epoch: number | null; disabled: boolean }>(
        `SELECT session_epoch, (disabled_at IS NOT NULL) AS disabled FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      row = res.rows[0];
    } catch (err) {
      // disabled_at is missing (42703) before migration 206: read the epoch alone.
      if ((err as { code?: string })?.code !== '42703') throw err;
      const res = await q.query<{ session_epoch: number | null }>(
        `SELECT session_epoch FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      row = res.rows[0];
    }
    // A disabled user can neither get a new cookie nor keep using an old one.
    if (!row || row.disabled === true) throw new Error('Unauthorized');
    return Number(row.session_epoch ?? 0);
  };
  if (db) return run(db);
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

/** Mint session + org cookies at the user's current epoch. */
export async function issueSessionCookies(
  res: Parameters<typeof applySessionCookies>[0],
  opts: Omit<Parameters<typeof applySessionCookies>[1], 'sessionEpoch'>
): Promise<void> {
  const sessionEpoch = await readSessionEpoch(opts.userId);
  await applySessionCookies(res, { ...opts, sessionEpoch });
}

/**
 * Parse the cookie and require its epoch to equal users.session_epoch.
 * Use this anywhere a cookie authorizes something outside getScopedClient()
 * (platform admin, /api/auth/session, impersonation end).
 */
export async function verifySessionCookie(
  raw: string | undefined | null
): Promise<ParsedSessionCookie | null> {
  const parsed = await parseSessionCookieParts(raw);
  if (!parsed) return null;
  let current: number;
  try {
    current = await readSessionEpoch(parsed.userId);
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') return null;
    throw err;
  }
  return current === parsed.epoch ? parsed : null;
}
