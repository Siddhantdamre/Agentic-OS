import { workerPool } from '../db.js';

const DEFAULT_STALE_MINUTES = 30;
const MIN_STALE_MINUTES = 5;

/** DAREX_DSR_STALE_MINUTES, floored at 5; junk values fall back to 30. */
export function dsrStaleMinutes(raw: string | undefined = process.env.DAREX_DSR_STALE_MINUTES): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_STALE_MINUTES ? Math.floor(n) : DEFAULT_STALE_MINUTES;
}

/**
 * Mark DSR delete jobs with no heartbeat for the stale window as failed,
 * through the SECURITY DEFINER `dsr_requests_reap_stale` (migration 203).
 */
export async function reapStaleDsrActivity(): Promise<{ reaped: number }> {
  const res = await workerPool.query<{ n: number }>(
    'SELECT dsr_requests_reap_stale($1::integer) AS n',
    [dsrStaleMinutes()]
  );
  return { reaped: Number(res.rows[0]?.n ?? 0) };
}
