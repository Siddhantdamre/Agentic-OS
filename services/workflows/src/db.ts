/**
 * Org-scoped Postgres helpers shared by Temporal activities.
 *
 * `withOrgClient` is the canonical export of the session-level RLS wrapper
 * that used to live privately in activities/orchestration.ts. It sets
 * `app.current_org_id` with `set_config(..., false)` and RESET+releases on
 * every path, including errors — a second copy that forgets RESET is how
 * tenancy leaks start.
 *
 * `readIdempotent` / `writeIdempotent` / `claimIdempotent` implement the
 * layer-3 claim pattern against `idempotency_keys` (11 §4). Reuse these;
 * do not write a second pair.
 */

import { PoolClient } from 'pg';
import { dbPool, withOrgScopedClient } from './tools/shared.js';

export { dbPool, dbPool as workerPool };
export type { PoolClient };

export async function withOrgClient<T>(
  orgId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  if (!orgId) {
    throw new Error('orgId is required');
  }
  return withOrgScopedClient(orgId, fn);
}

export async function readIdempotent<T>(orgId: string, key: string | undefined): Promise<T | null> {
  if (!key) return null;
  return withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT result FROM idempotency_keys WHERE key = $1 AND org_id = $2 AND expires_at > NOW()`,
      [key, orgId]
    );
    if (res.rows.length === 0) return null;
    return (res.rows[0].result as T) ?? null;
  });
}

export async function writeIdempotent(
  orgId: string,
  key: string | undefined,
  result: unknown
): Promise<void> {
  if (!key) return;
  await withOrgClient(orgId, async (client) => {
    await client.query(
      `INSERT INTO idempotency_keys (key, org_id, result, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result, expires_at = EXCLUDED.expires_at`,
      [key, orgId, JSON.stringify(result)]
    );
  });
}

/**
 * Atomically claim a key before an irreversible side effect (send/pay/sign)
 * runs, closing the crash window that a read-then-act-then-write check leaves
 * open. `result IS NULL` marks an in-flight claim; a completed result always
 * has a status field.
 */
export async function claimIdempotent<T>(
  orgId: string,
  key: string | undefined
): Promise<{ claimed: boolean; cached: T | null }> {
  if (!key) return { claimed: true, cached: null };
  return withOrgClient(orgId, async (client) => {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (key, org_id, result, expires_at)
       VALUES ($1, $2, NULL, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, orgId]
    );
    if (inserted.rows.length > 0) return { claimed: true, cached: null };

    const existing = await client.query(
      `SELECT result FROM idempotency_keys WHERE key = $1 AND org_id = $2 AND expires_at > NOW()`,
      [key, orgId]
    );
    if (existing.rows.length === 0 || existing.rows[0].result === null) {
      return { claimed: false, cached: null };
    }
    return { claimed: false, cached: existing.rows[0].result as T };
  });
}

/** O3: idempotency key is orgId + activityName + businessKey. */
export function sideEffectKey(orgId: string, activityName: string, businessKey: string): string {
  return `${orgId}:${activityName}:${businessKey}`;
}

export function isUndefinedTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { code?: string; message?: string };
  if (rec.code === '42P01') return true;
  return /does not exist/i.test(String(rec.message || ''));
}
