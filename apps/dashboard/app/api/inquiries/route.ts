import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { realtimeHub } from '@/lib/realtime-hub';

export const dynamic = 'force-dynamic';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

function parseLimit(raw: string | null): number {
  const n = parseInt(raw || String(DEFAULT_PAGE), 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE;
  return Math.min(Math.max(n, 1), MAX_PAGE);
}

function parseCursor(raw: string | null): { updatedAt: string; id: string } | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf('_');
  if (sep <= 0 || sep === raw.length - 1) return null;
  const updatedAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { updatedAt: new Date(ts).toISOString(), id };
}

function mapInquiry(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: 're.inquiry',
    listingRef: row.listing_id,
    contact: row.contact_id,
    contact_id: row.contact_id,
    channel: row.channel,
    status: row.status,
    bhk: row.bhk,
    locality: row.locality,
    city: row.city,
    budget_max: row.budget_max,
    sla_deadline_at: row.sla_deadline_at,
    sla_breached: row.sla_breached,
    responded_at: row.responded_at,
    assigned_agent_id: row.assigned_agent_id,
    matched_listing_ids: Array.isArray((row.payload as { matched_listing_ids?: unknown })?.matched_listing_ids)
      ? (row.payload as { matched_listing_ids: string[] }).matched_listing_ids
      : undefined,
    updatedAt: row.updated_at,
    updated_at: row.updated_at,
  };
}

export async function GET(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { searchParams } = new URL(request.url);
      const limit = parseLimit(searchParams.get('limit'));
      const cursor = parseCursor(searchParams.get('cursor'));
      const status = searchParams.get('status');
      const locality = searchParams.get('locality');

      const params: unknown[] = [orgId];
      let idx = 2;
      let statusClause = '';
      if (status && status !== 'all') {
        statusClause = ` AND status = $${idx}`;
        params.push(status);
        idx++;
      }
      let localityClause = '';
      if (locality) {
        localityClause = ` AND locality ILIKE $${idx}`;
        params.push(locality);
        idx++;
      }
      let cursorClause = '';
      if (cursor) {
        cursorClause = ` AND (updated_at, id) < ($${idx}::timestamptz, $${idx + 1}::uuid)`;
        params.push(cursor.updatedAt, cursor.id);
        idx += 2;
      }
      const limitParam = idx;
      params.push(limit + 1);

      const res = await client.query(
        `SELECT id, listing_id, contact_id, channel, status, bhk, locality, city,
                budget_max, currency, updated_at, sla_deadline_at, sla_breached,
                responded_at, assigned_agent_id, payload,
                CASE
                  WHEN status = 'new' AND sla_deadline_at IS NOT NULL AND sla_deadline_at < NOW()
                  THEN true ELSE COALESCE(sla_breached, false)
                END AS sla_breached_live
           FROM re_inquiries
          WHERE org_id = $1 AND deleted_at IS NULL
          ${statusClause}${localityClause}${cursorClause}
          ORDER BY updated_at DESC, id DESC
          LIMIT $${limitParam}`,
        params
      );

      const hasMore = res.rows.length > limit;
      const rows = hasMore ? res.rows.slice(0, limit) : res.rows;
      const last = rows[rows.length - 1];
      const nextCursor =
        hasMore && last?.updated_at && last?.id
          ? `${new Date(last.updated_at).toISOString()}_${last.id}`
          : null;

      // Persist breach flag when live check trips (no fabricated rows).
      const breachedIds = rows
        .filter((r) => r.sla_breached_live && !r.sla_breached)
        .map((r) => r.id);
      if (breachedIds.length > 0) {
        await client.query(
          `UPDATE re_inquiries SET sla_breached = true
            WHERE org_id = $1 AND id = ANY($2::uuid[])`,
          [orgId, breachedIds]
        );
      }

      return NextResponse.json({
        orgId,
        nextCursor,
        inquiries: rows.map((row) =>
          mapInquiry({ ...row, sla_breached: row.sla_breached_live || row.sla_breached })
        ),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (/re_inquiries|does not exist|relation|column/i.test(message)) {
      return NextResponse.json({ inquiries: [], nextCursor: null });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }

      const contactRaw = body.contact || body.contact_id || body.contactId || null;
      const contact =
        typeof contactRaw === 'string' && contactRaw.trim() ? contactRaw.trim().slice(0, 200) : null;
      const bhkRaw = body.bhk == null || body.bhk === '' ? null : Number(body.bhk);
      const bhk = bhkRaw != null && Number.isFinite(bhkRaw) && bhkRaw > 0 ? Math.floor(bhkRaw) : null;
      const budgetRaw = body.budget_max ?? body.budgetMax;
      const budgetNum =
        budgetRaw == null || budgetRaw === '' ? null : Number(budgetRaw);
      if (budgetNum != null && (!Number.isFinite(budgetNum) || budgetNum <= 0 || budgetNum > 1e12)) {
        return NextResponse.json(
          { error: 'budget_max must be a positive number within bounds' },
          { status: 400 }
        );
      }
      const locality =
        typeof body.locality === 'string'
          ? body.locality
          : typeof body.area === 'string'
            ? body.area
            : null;
      const city = typeof body.city === 'string' ? body.city : null;
      const listingId = body.listingId || body.listing_id || null;
      const channel = body.channel || null;
      const status = typeof body.status === 'string' ? body.status : 'new';

      // Dedup: refresh an active inquiry for the same contact within 7 days.
      if (contact) {
        const existing = await client.query(
          `SELECT id, status FROM re_inquiries
            WHERE org_id = $1 AND contact_id = $2
              AND status IN ('new', 'contacted')
              AND deleted_at IS NULL
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY updated_at DESC LIMIT 1`,
          [orgId, contact]
        );
        if (existing.rowCount && existing.rows[0]) {
          const id = existing.rows[0].id as string;
          const updated = await client.query(
            `UPDATE re_inquiries
                SET updated_at = NOW(),
                    bhk = COALESCE($1, bhk),
                    locality = COALESCE($2, locality),
                    city = COALESCE($3, city),
                    budget_max = COALESCE($4, budget_max),
                    listing_id = COALESCE($5, listing_id)
              WHERE id = $6 AND org_id = $7
              RETURNING id, listing_id, contact_id, channel, status, bhk, locality, city,
                        budget_max, currency, updated_at, sla_deadline_at, sla_breached,
                        responded_at, assigned_agent_id, payload`,
            [bhk, locality, city, budgetNum, listingId, id, orgId]
          );
          const row = updated.rows[0];
          realtimeHub.publish(orgId, {
            type: 'inquiry_updated',
            message: `Inquiry ${id} deduplicated`,
          });
          return NextResponse.json({
            inquiry: mapInquiry(row),
            deduplicated: true,
          });
        }
      }

      // Lightweight inventory match (same-org active listings) — no fabricated rows.
      const matches = await client.query(
        `SELECT id FROM re_listings
          WHERE org_id = $1
            AND status = 'active'
            AND ($2::int IS NULL OR bhk = $2)
            AND ($3::text IS NULL OR locality ILIKE $3)
            AND ($4::text IS NULL OR city ILIKE $4)
            AND ($5::numeric IS NULL OR list_price IS NULL OR list_price <= $5)
          ORDER BY updated_at DESC
          LIMIT 10`,
        [
          orgId,
          bhk,
          locality ? `%${locality}%` : null,
          city ? `%${city}%` : null,
          budgetNum,
        ]
      );
      const matchedIds = matches.rows.map((r) => r.id as string);

      const res = await client.query(
        `INSERT INTO re_inquiries (
           org_id, listing_id, contact_id, channel, status, bhk, locality, city, budget_max,
           currency, payload, sla_deadline_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW() + INTERVAL '15 minutes'
         )
         RETURNING id, listing_id, contact_id, channel, status, bhk, locality, city,
                   budget_max, currency, updated_at, sla_deadline_at, sla_breached,
                   responded_at, assigned_agent_id, payload, created_at`,
        [
          orgId,
          listingId,
          contact,
          channel,
          status,
          bhk,
          locality,
          city,
          budgetNum,
          body.currency || 'INR',
          JSON.stringify({ via: 'api', matched_listing_ids: matchedIds }),
        ]
      );

      const row = res.rows[0];
      realtimeHub.publish(orgId, {
        type: 'inquiry_updated',
        message: `Inquiry ${row.id} created`,
      });

      return NextResponse.json({
        inquiry: mapInquiry(row),
        matchedListingIds: matchedIds,
        deduplicated: false,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    // Unique active-contact race: treat as dedup conflict.
    const message = err instanceof Error ? err.message : String(err);
    if (/idx_re_inquiries_active_contact_dedup|unique/i.test(message)) {
      return NextResponse.json({ error: 'Duplicate active inquiry for contact' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
