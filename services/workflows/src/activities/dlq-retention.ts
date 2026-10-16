import { workerPool } from '../db.js';

const DEFAULT_RETENTION_DAYS = 30;

/** DAREX_DLQ_RETENTION_DAYS, floored at 1; junk values fall back to 30. */
export function dlqRetentionDays(raw: string | undefined = process.env.DAREX_DLQ_RETENTION_DAYS): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

/**
 * Webhooks #15: delete failed_webhooks rows older than the retention window
 * through the SECURITY DEFINER `failed_webhooks_purge` (migration 202).
 */
export async function purgeFailedWebhooksActivity(): Promise<{ deleted: number }> {
  const days = dlqRetentionDays();
  const res = await workerPool.query<{ n: number }>(
    'SELECT failed_webhooks_purge($1::integer) AS n',
    [days]
  );
  return { deleted: Number(res.rows[0]?.n ?? 0) };
}
