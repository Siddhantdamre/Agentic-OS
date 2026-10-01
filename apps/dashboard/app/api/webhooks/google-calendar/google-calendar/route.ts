import { NextResponse } from 'next/server';
import { pool, getOrgScopedClient } from '@/lib/db';
import { assertWebhookBodySize } from '@/lib/webhook-crypto';
import { recordFailedWebhook } from '@/lib/failed-webhooks';
import { verifyChannelToken } from '@/lib/gcal-watch';
import {
  NangoConnectorClient,
  listGoogleCalendarEventChanges,
} from '@darex/connectors';

export const dynamic = 'force-dynamic';

type ResolvedWatch = {
  org_id: string;
  channel_token_hash: string;
  status: string;
  sync_token: string | null;
  resource_id: string | null;
  calendar_id: string | null;
};

/**
 * POST /api/webhooks/google-calendar
 * Google Calendar push notifications. Fail closed unless X-Goog-Channel-Token
 * matches the stored channel token hash. Never invents calendar events or
 * showings — only updates rows that already have a matching calendar_event_id.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const size = assertWebhookBodySize(request, rawBody);
  if (!size.ok) {
    await recordFailedWebhook({
      channel: 'google-calendar',
      headers: request.headers,
      rawPayload: rawBody,
      errorMessage: size.error || 'body too large',
    });
    return new NextResponse(size.error || 'Payload Too Large', { status: size.status });
  }

  const channelId = request.headers.get('x-goog-channel-id') || '';
  const channelToken = request.headers.get('x-goog-channel-token') || '';
  const resourceState = (request.headers.get('x-goog-resource-state') || '').toLowerCase();
  const resourceId = request.headers.get('x-goog-resource-id') || '';

  if (!channelId || !channelToken) {
    await recordFailedWebhook({
      channel: 'google-calendar',
      headers: request.headers,
      rawPayload: rawBody,
      errorMessage: 'Missing X-Goog-Channel-Id or X-Goog-Channel-Token',
    });
    return NextResponse.json(
      { error: 'Missing channel id or token — fail closed' },
      { status: 401 }
    );
  }

  let watch: ResolvedWatch | null = null;
  try {
    const res = await pool.query(
      `SELECT org_id, channel_token_hash, status, sync_token, resource_id, calendar_id
         FROM resolve_gcal_watch($1)`,
      [channelId]
    );
    watch = (res.rows[0] as ResolvedWatch | undefined) || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/resolve_gcal_watch|does not exist|relation/i.test(message)) {
      return NextResponse.json(
        {
          ok: false,
          configured: false,
          message: 'gcal_calendar_watches migration not applied — no fake sync',
        },
        { status: 503 }
      );
    }
    throw err;
  }

  if (!watch) {
    await recordFailedWebhook({
      channel: 'google-calendar',
      headers: request.headers,
      rawPayload: rawBody,
      errorMessage: `Unknown channel id ${channelId}`,
    });
    return NextResponse.json({ error: 'Unknown channel — fail closed' }, { status: 401 });
  }

  if (!verifyChannelToken(channelToken, watch.channel_token_hash)) {
    await recordFailedWebhook({
      channel: 'google-calendar',
      headers: request.headers,
      rawPayload: rawBody,
      errorMessage: 'Invalid X-Goog-Channel-Token',
    });
    return NextResponse.json({ error: 'Invalid channel token — fail closed' }, { status: 401 });
  }

  if (watch.status === 'not_configured') {
    return NextResponse.json({
      ok: true,
      configured: false,
      synced: false,
      message: 'Watch is not_configured — acknowledged without sync (no fabricated events)',
    });
  }

  if (watch.status !== 'active') {
    return NextResponse.json({
      ok: true,
      configured: false,
      synced: false,
      status: watch.status,
      message: `Watch status=${watch.status} — no sync`,
    });
  }

  // Initial sync handshake from Google — acknowledge only.
  if (resourceState === 'sync') {
    const scoped = await getOrgScopedClient(watch.org_id);
    try {
      await scoped.client.query(
        `UPDATE gcal_calendar_watches
            SET last_notification_at = NOW(), updated_at = NOW(),
                resource_id = COALESCE($2, resource_id)
          WHERE channel_id = $1 AND org_id = $3`,
        [channelId, resourceId || null, watch.org_id]
      );
    } finally {
      scoped.client.release();
    }
    return NextResponse.json({ ok: true, configured: true, handshake: true });
  }

  const orgId = watch.org_id;
  const nango = new NangoConnectorClient();
  const changes = await listGoogleCalendarEventChanges(nango, orgId, {
    syncToken: watch.sync_token,
    calendarId: watch.calendar_id || 'primary',
  });

  if (!changes.connected) {
    return NextResponse.json({
      ok: true,
      configured: true,
      synced: false,
      connected: false,
      reconnectUrl: changes.reconnectUrl,
      message: changes.message,
    });
  }

  if (changes.needsFullSync) {
    // Honest: expired sync token — clear token, do not invent a full calendar dump as Darex inventory.
    const scoped = await getOrgScopedClient(orgId);
    try {
      await scoped.client.query(
        `UPDATE gcal_calendar_watches
            SET sync_token = NULL, last_notification_at = NOW(), updated_at = NOW()
          WHERE channel_id = $1 AND org_id = $2`,
        [channelId, orgId]
      );
    } finally {
      scoped.client.release();
    }
    return NextResponse.json({
      ok: true,
      configured: true,
      synced: false,
      needsFullSync: true,
      message: 'Google sync token expired (410). Cleared token; will not invent events.',
    });
  }

  let cancelled = 0;
  let rescheduled = 0;
  const scoped = await getOrgScopedClient(orgId);
  try {
    for (const event of changes.events) {
      const eventId = typeof event.id === 'string' ? event.id : '';
      if (!eventId) continue;

      const status = typeof event.status === 'string' ? event.status : '';
      if (status === 'cancelled') {
        const upd = await scoped.client.query(
          `UPDATE re_showings
              SET status = 'cancelled',
                  cancellation_reason = COALESCE(cancellation_reason, 'cancelled_in_google_calendar'),
                  updated_at = NOW()
            WHERE org_id = $1
              AND calendar_event_id = $2
              AND status <> 'cancelled'
            RETURNING id`,
          [orgId, eventId]
        );
        cancelled += upd.rowCount || 0;
        continue;
      }

      const start =
        (event.start as { dateTime?: string; date?: string } | undefined)?.dateTime ||
        (event.start as { dateTime?: string; date?: string } | undefined)?.date ||
        null;
      const end =
        (event.end as { dateTime?: string; date?: string } | undefined)?.dateTime ||
        (event.end as { dateTime?: string; date?: string } | undefined)?.date ||
        null;
      if (!start) continue;

      const upd = await scoped.client.query(
        `UPDATE re_showings
            SET starts_at = $3::timestamptz,
                ends_at = COALESCE($4::timestamptz, ends_at),
                updated_at = NOW()
          WHERE org_id = $1
            AND calendar_event_id = $2
            AND status IN ('booked', 'proposed')
            AND (
              starts_at IS DISTINCT FROM $3::timestamptz
              OR ($4::timestamptz IS NOT NULL AND ends_at IS DISTINCT FROM $4::timestamptz)
            )
          RETURNING id`,
        [orgId, eventId, start, end]
      );
      rescheduled += upd.rowCount || 0;
    }

    if (changes.nextSyncToken) {
      await scoped.client.query(
        `UPDATE gcal_calendar_watches
            SET sync_token = $2,
                last_notification_at = NOW(),
                updated_at = NOW(),
                resource_id = COALESCE($3, resource_id)
          WHERE channel_id = $1 AND org_id = $4`,
        [channelId, changes.nextSyncToken, resourceId || null, orgId]
      );
    } else {
      await scoped.client.query(
        `UPDATE gcal_calendar_watches
            SET last_notification_at = NOW(), updated_at = NOW()
          WHERE channel_id = $1 AND org_id = $2`,
        [channelId, orgId]
      );
    }
  } finally {
    scoped.client.release();
  }

  return NextResponse.json({
    ok: true,
    configured: true,
    synced: true,
    cancelled,
    rescheduled,
    // Never report invented showings from calendar noise.
    invented: false,
  });
}
