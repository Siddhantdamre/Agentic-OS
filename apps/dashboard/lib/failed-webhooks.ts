import { pool, getOrgScopedClient } from '@/lib/db';
import type { OutboundResult } from '@/lib/channel-outbound';

/**
 * Persist unparseable / unauthorized / permanently failed webhook payloads for replay.
 * Never stores secrets from headers (Authorization redacted).
 */
/** Mask a phone / email / id to its last 4 characters for DLQ rows (CH-S07). */
export function maskRecipient(value: string | null | undefined): string {
  const v = (value || '').trim();
  if (!v) return '';
  const at = v.indexOf('@');
  if (at > 0) return `${v[0]}***${v.slice(at)}`;
  if (v.length <= 4) return '***';
  return `***${v.slice(-4)}`;
}

export async function recordFailedWebhook(input: {
  /**
   * Tenant when known. Rows with NULL org_id are invisible under FORCE RLS
   * (117), so pass it whenever the org has been resolved (CH-S07).
   */
  orgId?: string | null;
  channel: string;
  sourceIp?: string | null;
  headers?: Headers | Record<string, string> | null;
  rawPayload: string;
  errorMessage: string;
}): Promise<void> {
  const safeHeaders: Record<string, string> = {};
  if (input.headers) {
    const entries =
      typeof (input.headers as Headers).forEach === 'function'
        ? Array.from((input.headers as Headers).entries())
        : Object.entries(input.headers as Record<string, string>);
    for (const [key, value] of entries) {
      const lower = key.toLowerCase();
      if (lower === 'authorization' || lower.includes('token') || lower.includes('secret')) {
        safeHeaders[key] = '[redacted]';
      } else {
        safeHeaders[key] = String(value).slice(0, 500);
      }
    }
  }
  const params = [
    input.channel,
    input.sourceIp || null,
    JSON.stringify(safeHeaders),
    input.rawPayload.slice(0, 200_000),
    input.errorMessage.slice(0, 2000),
    input.orgId || null,
  ];
  const sql = `INSERT INTO failed_webhooks (channel, source_ip, headers, raw_payload, error_message, org_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`;
  try {
    if (input.orgId) {
      // RLS WITH CHECK requires app.current_org_id to match a non-null org_id.
      const { client } = await getOrgScopedClient(input.orgId);
      try {
        await client.query(sql, params);
      } finally {
        client.release();
      }
    } else {
      await pool.query(sql, params);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Table may not exist until migration 093/117 — log and continue.
    console.error('[failed-webhooks] insert skipped:', message);
  }
}

export async function updateMessageDeliveryStatus(input: {
  orgId: string;
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestampSec?: string | number | null;
}): Promise<boolean> {
  const { client } = await getOrgScopedClient(input.orgId);
  try {
    const res = await client.query(
      `UPDATE messages
          SET delivery_status = $1,
              delivery_updated_at = COALESCE(to_timestamp($2::double precision), NOW())
        WHERE org_id = $3 AND chatwoot_msg_id = $4
        RETURNING id`,
      [
        input.status,
        input.timestampSec != null && input.timestampSec !== ''
          ? Number(input.timestampSec)
          : null,
        input.orgId,
        input.providerMessageId,
      ]
    );
    return (res.rowCount || 0) > 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('delivery_status')) {
      console.warn('[delivery-status] column missing — apply migration 093');
      return false;
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record the outcome of an external send on the outbound message row: the
 * provider id (WhatsApp wamid) so later receipts match via
 * updateMessageDeliveryStatus, and `failed` when the send did not go out
 * (CH-B01, CH-B12). Pass `messageId` when known; otherwise the newest
 * unmatched row of `role` in the conversation is used (workflow-persisted
 * replies do not hand their id back). No-op when nothing was attempted.
 */
export async function recordOutboundDelivery(input: {
  orgId: string;
  result: OutboundResult;
  messageId?: string | null;
  conversationId?: string | null;
  role?: 'assistant' | 'human_agent';
}): Promise<boolean> {
  if (!input.result.attempted) return false;
  const status = input.result.sent ? 'sent' : 'failed';
  const providerId = input.result.sent ? input.result.providerMessageId || null : null;
  if (!input.messageId && !input.conversationId) return false;
  const { client } = await getOrgScopedClient(input.orgId);
  try {
    const res = input.messageId
      ? await client.query(
          `UPDATE messages
              SET delivery_status = $1,
                  delivery_updated_at = NOW(),
                  chatwoot_msg_id = COALESCE($2, chatwoot_msg_id)
            WHERE org_id = $3 AND id = $4
            RETURNING id`,
          [status, providerId, input.orgId, input.messageId]
        )
      : await client.query(
          `UPDATE messages
              SET delivery_status = $1,
                  delivery_updated_at = NOW(),
                  chatwoot_msg_id = COALESCE($2, chatwoot_msg_id)
            WHERE org_id = $3
              AND id = (
                SELECT id FROM messages
                 WHERE org_id = $3 AND conversation_id = $4 AND role = $5
                   AND chatwoot_msg_id IS NULL
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
              )
            RETURNING id`,
          [status, providerId, input.orgId, input.conversationId, input.role || 'assistant']
        );
    return (res.rowCount || 0) > 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[delivery-status] outbound outcome not recorded:', message);
    return false;
  } finally {
    client.release();
  }
}
