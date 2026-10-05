import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import {
  NangoConnectorClient,
  intervalOverlapsBusy,
  queryGoogleCalendarFreeBusy,
} from '@darex/connectors';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['proposed', 'booked', 'completed', 'cancelled', 'no_show']);

function missingTables(message: string): boolean {
  return /re_showings|does not exist|relation/i.test(message);
}

async function deleteCalendarEvent(orgId: string, eventId: string | null): Promise<void> {
  if (!eventId) return;
  const nango = new NangoConnectorClient();
  try {
    await nango.proxyRequest(
      orgId,
      'google-calendar',
      `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      'DELETE'
    );
  } catch {
    // Best-effort: DB cancel still proceeds if calendar delete fails.
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid showing id' }, { status: 400 });
    }
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }

      const existing = await client.query(
        `SELECT * FROM re_showings WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [id, orgId]
      );
      if (!existing.rows[0]) {
        return NextResponse.json({ error: 'Showing not found', invented: false }, { status: 404 });
      }
      const current = existing.rows[0];

      let startsAt =
        typeof body.startsAt === 'string'
          ? body.startsAt
          : typeof body.startTime === 'string'
            ? body.startTime
            : null;
      let endsAt =
        typeof body.endsAt === 'string'
          ? body.endsAt
          : typeof body.endTime === 'string'
            ? body.endTime
            : null;
      if (startsAt) {
        const d = new Date(startsAt);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: 'startsAt must be ISO-8601' }, { status: 400 });
        }
        startsAt = d.toISOString();
      }
      if (endsAt) {
        const d = new Date(endsAt);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: 'endsAt must be ISO-8601' }, { status: 400 });
        }
        endsAt = d.toISOString();
      }

      const status = body.status != null ? String(body.status) : null;
      if (status && !STATUSES.has(status)) {
        return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
      }

      if (startsAt && endsAt) {
        const conflictCheck = await client.query(
          `SELECT id, starts_at, ends_at FROM re_showings
            WHERE org_id = $1
              AND id <> $2
              AND status IN ('booked', 'proposed')
              AND starts_at < $4::timestamptz
              AND ends_at > $3::timestamptz
              AND ($5::uuid IS NULL OR listing_id = $5::uuid OR listing_id IS NULL)
            LIMIT 5`,
          [orgId, id, startsAt, endsAt, current.listing_id]
        );
        if (conflictCheck.rowCount && conflictCheck.rowCount > 0) {
          return NextResponse.json(
            {
              error: 'Time slot conflicts with another showing',
              conflict: true,
              conflicts: conflictCheck.rows,
              booked: false,
            },
            { status: 409 }
          );
        }

        const nango = new NangoConnectorClient();
        const freeBusy = await queryGoogleCalendarFreeBusy(nango, orgId, startsAt, endsAt);
        if (!freeBusy.connected) {
          return NextResponse.json(
            {
              error: freeBusy.message,
              connected: false,
              reconnectUrl: freeBusy.reconnectUrl,
              setupUrl: freeBusy.setupUrl,
              booked: false,
            },
            { status: 409 }
          );
        }
        if (intervalOverlapsBusy(startsAt, endsAt, freeBusy.busy)) {
          return NextResponse.json(
            {
              error: 'Google Calendar reports the agent is busy for this slot.',
              conflict: true,
              busy: freeBusy.busy,
              booked: false,
            },
            { status: 409 }
          );
        }
      }

      const res = await client.query(
        `UPDATE re_showings
            SET status = COALESCE($1, status),
                starts_at = COALESCE($2::timestamptz, starts_at),
                ends_at = COALESCE($3::timestamptz, ends_at),
                feedback_rating = COALESCE($4, feedback_rating),
                feedback_notes = COALESCE($5, feedback_notes),
                cancellation_reason = COALESCE($6, cancellation_reason),
                timezone = COALESCE($7, timezone),
                duration_minutes = COALESCE($8, duration_minutes),
                updated_at = NOW()
          WHERE id = $9 AND org_id = $10
          RETURNING *`,
        [
          status,
          startsAt,
          endsAt,
          body.feedbackRating != null ? Number(body.feedbackRating) : null,
          body.feedbackNotes != null ? String(body.feedbackNotes) : null,
          body.cancellationReason != null ? String(body.cancellationReason) : null,
          body.timezone != null ? String(body.timezone) : null,
          body.durationMinutes != null ? Number(body.durationMinutes) : null,
          id,
          orgId,
        ]
      );

      return NextResponse.json({ showing: res.rows[0], invented: false });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json({ error: '015_packs.sql not applied' }, { status: 503 });
    }
    console.error('PATCH /api/showings/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid showing id' }, { status: 400 });
    }
    const { client, orgId } = await getScopedClient();
    try {
      let cancellationReason: string | null = null;
      try {
        const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
        const rejected = rejectBodyOrgId(body);
        if (rejected) {
          return NextResponse.json({ error: rejected }, { status: 400 });
        }
        if (body.cancellationReason != null) cancellationReason = String(body.cancellationReason);
      } catch {
        // empty body ok
      }

      const existing = await client.query(
        `SELECT id, calendar_event_id, status FROM re_showings WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [id, orgId]
      );
      if (!existing.rows[0]) {
        return NextResponse.json({ error: 'Showing not found', invented: false }, { status: 404 });
      }

      await deleteCalendarEvent(orgId, existing.rows[0].calendar_event_id);

      await client.query(
        `UPDATE re_showings
            SET status = 'cancelled',
                cancellation_reason = COALESCE($1, cancellation_reason),
                updated_at = NOW()
          WHERE id = $2 AND org_id = $3`,
        [cancellationReason, id, orgId]
      );

      return NextResponse.json({
        success: true,
        message: 'Showing cancelled',
        id,
        invented: false,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('DELETE /api/showings/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
