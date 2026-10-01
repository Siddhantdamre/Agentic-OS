import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { bookShowingActivity } from '@darex/workflows/dist/activities/packs';
import {
  startShowingReminderWorkflow,
  startShowingScheduleWorkflow,
} from '@darex/workflows/dist/workflow-client';
import {
  NangoConnectorClient,
  intervalOverlapsBusy,
  queryGoogleCalendarFreeBusy,
} from '@darex/connectors';
import { ensureOrgGoogleCalendarWatch } from '@/lib/gcal-watch';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asUuid(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !UUID_RE.test(text)) return null;
  return text;
}

function missingTables(message: string): boolean {
  return /re_showings|re_listings|re_inquiries|does not exist|relation/i.test(message);
}

export async function GET(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { searchParams } = new URL(request.url);
      const listingId = asUuid(searchParams.get('listingId'));
      const inquiryId = asUuid(searchParams.get('inquiryId'));
      const params: unknown[] = [orgId];
      let sql = `
        SELECT id, listing_id, inquiry_id, status, starts_at, ends_at, calendar_event_id, conflict, updated_at
          FROM re_showings
         WHERE org_id = $1`;
      let i = 2;
      if (listingId) {
        sql += ` AND listing_id = $${i}`;
        params.push(listingId);
        i += 1;
      }
      if (inquiryId) {
        sql += ` AND inquiry_id = $${i}`;
        params.push(inquiryId);
        i += 1;
      }
      sql += ` ORDER BY starts_at DESC NULLS LAST LIMIT 100`;
      const res = await client.query(sql, params);
      return NextResponse.json({
        orgId,
        showings: res.rows.map((row) => ({
          id: row.id,
          listingId: row.listing_id,
          inquiryId: row.inquiry_id,
          status: row.status,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          calendarEventId: row.calendar_event_id,
          conflict: row.conflict,
          updatedAt: row.updated_at,
        })),
        invented: false,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json({ showings: [], invented: false });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    let listingId: string | undefined;
    let inquiryId: string | undefined;
    let startTime = '';
    let endTime: string | undefined;
    let summary: string | undefined;
    let timezone = 'UTC';
    let durationMinutes = 60;

    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }

      startTime = typeof body.startTime === 'string' ? body.startTime.trim() : '';
      if (!startTime) {
        return NextResponse.json({ error: 'startTime (ISO-8601) is required' }, { status: 400 });
      }
      const parsedStart = new Date(startTime);
      if (Number.isNaN(parsedStart.getTime())) {
        return NextResponse.json({ error: 'startTime must be a valid ISO-8601 datetime' }, { status: 400 });
      }
      startTime = parsedStart.toISOString();

      if (typeof body.endTime === 'string' && body.endTime.trim()) {
        const parsedEnd = new Date(body.endTime.trim());
        if (Number.isNaN(parsedEnd.getTime())) {
          return NextResponse.json({ error: 'endTime must be a valid ISO-8601 datetime' }, { status: 400 });
        }
        endTime = parsedEnd.toISOString();
      } else {
        durationMinutes =
          typeof body.durationMinutes === 'number' && body.durationMinutes > 0
            ? Math.min(Math.floor(body.durationMinutes), 480)
            : typeof body.durationMinutes === 'string' && Number(body.durationMinutes) > 0
              ? Math.min(Math.floor(Number(body.durationMinutes)), 480)
              : 60;
        endTime = new Date(parsedStart.getTime() + durationMinutes * 60 * 1000).toISOString();
      }

      timezone =
        typeof body.timezone === 'string' && body.timezone.trim()
          ? body.timezone.trim().slice(0, 64)
          : 'UTC';

      if (typeof body.summary === 'string' && body.summary.trim()) {
        summary = body.summary.trim().slice(0, 200);
      }

      const listingRaw = asUuid(body.listingId ?? body.listing_id);
      const inquiryRaw = asUuid(body.inquiryId ?? body.inquiry_id);
      if (body.listingId && !listingRaw) {
        return NextResponse.json({ error: 'listingId must be a listing UUID from this org' }, { status: 400 });
      }
      if (body.inquiryId && !inquiryRaw) {
        return NextResponse.json({ error: 'inquiryId must be an inquiry UUID from this org' }, { status: 400 });
      }

      if (listingRaw) {
        const listing = await client.query(
          `SELECT id FROM re_listings WHERE id = $1 AND org_id = $2 LIMIT 1`,
          [listingRaw, orgId]
        );
        if (!listing.rows[0]) {
          return NextResponse.json(
            { error: 'Listing not in this org. Will not invent a unit.', booked: false, invented: false },
            { status: 404 }
          );
        }
        listingId = listingRaw;
      }

      if (inquiryRaw) {
        const inquiry = await client.query(
          `SELECT id, listing_id FROM re_inquiries WHERE id = $1 AND org_id = $2 LIMIT 1`,
          [inquiryRaw, orgId]
        );
        if (!inquiry.rows[0]) {
          return NextResponse.json(
            { error: 'Inquiry not in this org. Will not invent a lead.', booked: false, invented: false },
            { status: 404 }
          );
        }
        inquiryId = inquiryRaw;
        if (!listingId && inquiry.rows[0].listing_id) {
          listingId = String(inquiry.rows[0].listing_id);
        }
      }

      // DB overlap check (parameterized, org from session) before any calendar write.
      const dbConflict = await client.query(
        `SELECT id, starts_at, ends_at, listing_id, status
           FROM re_showings
          WHERE org_id = $1
            AND status IN ('booked', 'proposed')
            AND starts_at < $3::timestamptz
            AND ends_at > $2::timestamptz
            AND ($4::uuid IS NULL OR listing_id = $4::uuid OR listing_id IS NULL)
          LIMIT 5`,
        [orgId, startTime, endTime, listingId ?? null]
      );
      if (dbConflict.rowCount && dbConflict.rowCount > 0) {
        return NextResponse.json(
          {
            booked: false,
            conflict: true,
            invented: false,
            error: 'Time slot conflicts with an existing showing for this org.',
            conflicts: dbConflict.rows.map((row) => ({
              id: row.id,
              listingId: row.listing_id,
              startsAt: row.starts_at,
              endsAt: row.ends_at,
              status: row.status,
            })),
          },
          { status: 409 }
        );
      }

      // Real Google Calendar free/busy — refuse when disconnected (unknown conflicts).
      const nango = new NangoConnectorClient();
      const freeBusy = await queryGoogleCalendarFreeBusy(nango, orgId, startTime, endTime!);
      if (!freeBusy.connected) {
        return NextResponse.json(
          {
            booked: false,
            conflict: false,
            invented: false,
            connected: false,
            reconnectUrl: freeBusy.reconnectUrl,
            setupUrl: freeBusy.setupUrl,
            reason: freeBusy.reason,
            error: freeBusy.message,
          },
          { status: 409 }
        );
      }
      if (intervalOverlapsBusy(startTime, endTime!, freeBusy.busy)) {
        return NextResponse.json(
          {
            booked: false,
            conflict: true,
            invented: false,
            connected: true,
            error: 'Google Calendar reports the agent is busy for this slot.',
            busy: freeBusy.busy.filter((slot) =>
              intervalOverlapsBusy(startTime, endTime!, [slot])
            ),
          },
          { status: 409 }
        );
      }
    } finally {
      client.release();
    }

    const businessKey = `showing:${orgId}:${listingId || inquiryId || 'open'}:${startTime}`;
    const input = {
      orgId,
      listingId,
      inquiryId,
      startTime,
      endTime,
      summary: summary || 'Property showing',
      idempotencyKey: businessKey,
    };

    const handle = await startShowingScheduleWorkflow(input);
    let bookResult: Record<string, unknown>;
    if (handle) {
      bookResult = { ...(await handle.result()), via: 'temporal', invented: false, timezone, durationMinutes };
    } else {
      const direct = await bookShowingActivity({
        orgId,
        listingId,
        inquiryId,
        startTime,
        endTime,
        summary: input.summary,
        businessKey,
      });
      bookResult = { ...direct, via: 'direct', invented: false, timezone, durationMinutes };
    }

    const showingId =
      typeof bookResult.showingId === 'string'
        ? bookResult.showingId
        : bookResult.showing &&
            typeof bookResult.showing === 'object' &&
            bookResult.showing !== null &&
            'id' in bookResult.showing
          ? String((bookResult.showing as { id: unknown }).id)
          : null;

    let reminders: { scheduled: boolean; workflowId?: string; message: string } = {
      scheduled: false,
      message: 'Reminders not scheduled',
    };
    if (bookResult.booked === true && showingId) {
      const reminderHandle = await startShowingReminderWorkflow({
        orgId,
        showingId,
        startsAt: startTime,
        idempotencyKey: showingId,
      });
      reminders = reminderHandle
        ? { scheduled: true, workflowId: reminderHandle.workflowId, message: 'ShowingReminderWorkflow started' }
        : { scheduled: false, message: 'Temporal unavailable — reminders not scheduled (no fake send)' };
    }

    // Best-effort two-way calendar watch — never fabricates sync when webhook URL unset.
    let calendarWatch: Record<string, unknown> | null = null;
    if (bookResult.booked === true && bookResult.connected !== false) {
      try {
        const scoped = await getScopedClient();
        try {
          calendarWatch = await ensureOrgGoogleCalendarWatch(scoped.client, orgId);
        } finally {
          scoped.client.release();
        }
      } catch (watchErr) {
        calendarWatch = {
          configured: false,
          status: 'error',
          message: watchErr instanceof Error ? watchErr.message : String(watchErr),
        };
      }
    }

    return NextResponse.json({ ...bookResult, reminders, calendarWatch });
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json(
        { error: '015_packs.sql not applied', booked: false, invented: false },
        { status: 503 }
      );
    }
    console.error('API POST /api/showings', err);
    return NextResponse.json({ error: 'Internal Server Error', booked: false }, { status: 500 });
  }
}
