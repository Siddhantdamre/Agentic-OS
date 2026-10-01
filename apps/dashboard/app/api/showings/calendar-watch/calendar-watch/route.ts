import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { ensureOrgGoogleCalendarWatch } from '@/lib/gcal-watch';

export const dynamic = 'force-dynamic';

/**
 * POST /api/showings/calendar-watch
 * Register (or honestly report not-configured) a Google Calendar push channel
 * for the session org. Does not invent sync when webhook URL / OAuth is missing.
 */
export async function POST() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const result = await ensureOrgGoogleCalendarWatch(client, orgId);
      return NextResponse.json({ orgId, ...result, invented: false });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (/gcal_calendar_watches|does not exist|relation/i.test(message)) {
      return NextResponse.json(
        {
          configured: false,
          status: 'not_configured',
          message: '102_showing_reminders_gcal_watch.sql not applied',
          invented: false,
        },
        { status: 503 }
      );
    }
    console.error('POST /api/showings/calendar-watch', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT channel_id, status, resource_id, expiration, webhook_address,
                not_configured_reason, last_notification_at, created_at
           FROM gcal_calendar_watches
          WHERE org_id = $1
          ORDER BY created_at DESC
          LIMIT 5`,
        [orgId]
      );
      return NextResponse.json({
        orgId,
        watches: res.rows.map((row) => ({
          channelId: row.channel_id,
          status: row.status,
          resourceId: row.resource_id,
          expiration: row.expiration,
          webhookAddress: row.webhook_address,
          notConfiguredReason: row.not_configured_reason,
          lastNotificationAt: row.last_notification_at,
          createdAt: row.created_at,
        })),
        invented: false,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    const message = err instanceof Error && err.message ? err.message : String(err);
    if (/gcal_calendar_watches|does not exist|relation/i.test(message)) {
      return NextResponse.json({ watches: [], invented: false });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
