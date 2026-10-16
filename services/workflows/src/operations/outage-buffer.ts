/**
 * Claim-before-replay outage buffer (P3-BUF-1 / 11 §4).
 * Persist intended connector work on channel_logs, then claim the
 * idempotency key before a flush so a retry cannot double-send.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { claimIdempotent, isUndefinedTable, writeIdempotent } from '../db.js';

export const OUTAGE_BUFFER_EVENT = 'CONNECTOR_OUTAGE_BUFFER';

export interface BufferedEffect {
  orgId: string;
  channel: string;
  action: string;
  payload: Record<string, unknown>;
  workflowId: string;
}

export function bufferKey(effect: BufferedEffect): string {
  const material = [
    effect.orgId,
    effect.workflowId,
    effect.channel,
    effect.action,
    JSON.stringify(effect.payload),
  ].join('|');
  return createHash('sha256').update(material).digest('hex');
}

export async function persistBufferedEffect(
  client: PoolClient,
  effect: BufferedEffect
): Promise<{ logId: string | null; key: string }> {
  const key = bufferKey(effect);
  try {
    const res = await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, $3, 'pending', 503, $4, $5::jsonb)
       RETURNING id`,
      [
        effect.orgId,
        effect.channel,
        OUTAGE_BUFFER_EVENT,
        `${effect.action} buffered during connector outage`,
        JSON.stringify({ ...effect.payload, action: effect.action, bufferKey: key, workflowId: effect.workflowId }),
      ]
    );
    return { logId: String(res.rows[0].id), key };
  } catch (err) {
    if (isUndefinedTable(err)) return { logId: null, key };
    throw err;
  }
}

export interface FlushResult {
  flushed: boolean;
  replayed: boolean;
  cached: unknown | null;
  reason: 'claimed' | 'replayed' | 'in_flight';
}

export async function claimAndFlushBuffered(
  orgId: string,
  key: string,
  flush: () => Promise<unknown>
): Promise<FlushResult> {
  const claim = await claimIdempotent<unknown>(orgId, key);
  if (!claim.claimed && claim.cached != null) {
    return { flushed: false, replayed: true, cached: claim.cached, reason: 'replayed' };
  }
  if (!claim.claimed) {
    return { flushed: false, replayed: false, cached: null, reason: 'in_flight' };
  }
  const result = await flush();
  await writeIdempotent(orgId, key, result ?? { status: 'flushed' });
  return { flushed: true, replayed: false, cached: result, reason: 'claimed' };
}

export async function listPendingBuffers(
  client: PoolClient,
  orgId: string
): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  try {
    const res = await client.query(
      `SELECT id, payload FROM channel_logs
        WHERE org_id = $1 AND event_type = $2 AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 50`,
      [orgId, OUTAGE_BUFFER_EVENT]
    );
    return res.rows.map((row) => ({
      id: String(row.id),
      payload: (row.payload ?? {}) as Record<string, unknown>,
    }));
  } catch (err) {
    if (isUndefinedTable(err)) return [];
    throw err;
  }
}
