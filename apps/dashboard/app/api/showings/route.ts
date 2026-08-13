import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { bookShowingActivity } from '@darex/workflows/dist/activities/packs';
import { startShowingScheduleWorkflow } from '@darex/workflows/dist/workflow-client';

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
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
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
        endTime = new Date(parsedStart.getTime() + 60 * 60 * 1000).toISOString();
      }

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
    if (handle) {
      const result = await handle.result();
      return NextResponse.json({ ...result, via: 'temporal', invented: false });
    }

    const direct = await bookShowingActivity({
      orgId,
      listingId,
      inquiryId,
      startTime,
      endTime,
      summary: input.summary,
      businessKey,
    });
    return NextResponse.json({ ...direct, via: 'direct', invented: false });
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
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
