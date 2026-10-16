import crypto from 'crypto';
import type { PoolClient } from 'pg';
import {
  NangoConnectorClient,
  requestGoogleCalendarWatch,
  resolveGoogleCalendarWebhookAddress,
  type GoogleCalendarWatchRequestResult,
} from '@darex/connectors';

function hashChannelToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyChannelToken(provided: string, tokenHash: string): boolean {
  if (!provided || !tokenHash) return false;
  const providedHash = hashChannelToken(provided);
  const a = Buffer.from(providedHash);
  const b = Buffer.from(tokenHash);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Persist + optionally register a Google Calendar push watch for this org.
 * When webhook URL / OAuth is missing, stores status=not_configured honestly.
 */
export async function ensureOrgGoogleCalendarWatch(
  client: PoolClient,
  orgId: string
): Promise<Record<string, unknown>> {
  const address = resolveGoogleCalendarWebhookAddress();
  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashChannelToken(channelToken);

  if (!address) {
    await client.query(
      `INSERT INTO gcal_calendar_watches (
         org_id, channel_id, channel_token_hash, status, webhook_address, not_configured_reason
       ) VALUES ($1, $2, $3, 'not_configured', NULL, $4)`,
      [
        orgId,
        channelId,
        tokenHash,
        'GOOGLE_CALENDAR_WEBHOOK_URL / DAREX_PUBLIC_BASE_URL unset — push not registered',
      ]
    );
    return {
      configured: false,
      status: 'not_configured',
      channelId,
      message:
        'Calendar push webhook URL not configured. Watch intent persisted as not_configured; no fake sync.',
    };
  }

  // Reuse an active non-expired watch when present.
  const existing = await client.query(
    `SELECT channel_id, status, expiration, resource_id
       FROM gcal_calendar_watches
      WHERE org_id = $1 AND status = 'active'
        AND (expiration IS NULL OR expiration > NOW())
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId]
  );
  if (existing.rows[0]) {
    return {
      configured: true,
      status: 'active',
      channelId: existing.rows[0].channel_id,
      resourceId: existing.rows[0].resource_id,
      expiration: existing.rows[0].expiration,
      reused: true,
      message: 'Existing Google Calendar push channel is active',
    };
  }

  const nango = new NangoConnectorClient();
  const watch: GoogleCalendarWatchRequestResult = await requestGoogleCalendarWatch(nango, orgId, {
    channelId,
    channelToken,
  });

  if (!watch.configured) {
    await client.query(
      `INSERT INTO gcal_calendar_watches (
         org_id, channel_id, channel_token_hash, status, webhook_address, not_configured_reason
       ) VALUES ($1, $2, $3, 'not_configured', $4, $5)`,
      [orgId, channelId, tokenHash, address, watch.message]
    );
    return {
      configured: false,
      status: 'not_configured',
      channelId,
      reason: watch.reason,
      message: watch.message,
      reconnectUrl: 'reconnectUrl' in watch ? watch.reconnectUrl : undefined,
      setupUrl: 'setupUrl' in watch ? watch.setupUrl : undefined,
    };
  }

  await client.query(
    `INSERT INTO gcal_calendar_watches (
       org_id, channel_id, channel_token_hash, resource_id, calendar_id,
       webhook_address, expiration, status
     ) VALUES ($1, $2, $3, $4, 'primary', $5, $6::timestamptz, 'active')`,
    [orgId, watch.channelId, tokenHash, watch.resourceId, watch.webhookAddress, watch.expiration]
  );

  return {
    configured: true,
    status: 'active',
    channelId: watch.channelId,
    resourceId: watch.resourceId,
    expiration: watch.expiration,
    webhookAddress: watch.webhookAddress,
    message: 'Google Calendar push channel registered',
  };
}
