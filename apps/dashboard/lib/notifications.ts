import type { PoolClient } from 'pg';

export type ImmediateNotificationResult = {
  sent: boolean;
  skipped: boolean;
  reason?: 'rate_limited' | 'missing_table' | 'recorded';
};

function isMissingTable(err: unknown, table: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && message.includes(table);
}

/**
 * Cap immediate notifications at one per hour per org.
 * Returns skipped=true when a row already exists in the last hour.
 */
export async function recordImmediateNotification(
  client: PoolClient,
  orgId: string,
  payload: Record<string, unknown> = {}
): Promise<ImmediateNotificationResult> {
  try {
    const recent = await client.query(
      `SELECT id FROM org_notification_log
        WHERE org_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
        LIMIT 1`,
      [orgId]
    );
    if (recent.rows.length > 0) {
      return { sent: false, skipped: true, reason: 'rate_limited' };
    }
    await client.query(
      `INSERT INTO org_notification_log (org_id, kind, summary, payload, created_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())`,
      [
        orgId,
        typeof payload.kind === 'string' ? payload.kind : 'immediate',
        typeof payload.summary === 'string' ? payload.summary : '',
        JSON.stringify(payload),
      ]
    );
    return { sent: true, skipped: false, reason: 'recorded' };
  } catch (err: unknown) {
    if (isMissingTable(err, 'org_notification_log')) {
      return { sent: false, skipped: true, reason: 'missing_table' };
    }
    throw err;
  }
}
