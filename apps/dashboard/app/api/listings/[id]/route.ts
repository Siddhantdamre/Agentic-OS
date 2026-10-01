import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { realtimeHub } from '@/lib/realtime-hub';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set([
  'draft',
  'active',
  'under_offer',
  'reserved',
  'sold',
  'rented',
  'withdrawn',
  'stale',
]);

function missingTables(message: string): boolean {
  return /re_listings|re_listing_|does not exist|relation/i.test(message);
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  try {
    const { id } = await Promise.resolve(context.params);
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 });
    }
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT id, source, source_ref, title, locality, city, bhk, list_price, currency,
                rera_id, status, amenities, address_line, postal_code, latitude, longitude,
                last_source_sync_at, updated_at
           FROM re_listings
          WHERE id = $1 AND org_id = $2
          LIMIT 1`,
        [id, orgId]
      );
      if (!res.rows[0]) {
        return NextResponse.json({ error: 'Listing not found', invented: false }, { status: 404 });
      }
      let media: unknown[] = [];
      try {
        const mediaRes = await client.query(
          `SELECT id, media_type, url, thumbnail_url, caption, display_order
             FROM re_listing_media
            WHERE listing_id = $1 AND org_id = $2
            ORDER BY display_order ASC, created_at ASC`,
          [id, orgId]
        );
        media = mediaRes.rows;
      } catch {
        media = [];
      }
      return NextResponse.json({ listing: { ...res.rows[0], media }, invented: false });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json({ error: '015_packs.sql not applied', invented: false }, { status: 503 });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  try {
    const { id } = await Promise.resolve(context.params);
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 });
    }
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }

      const existing = await client.query(
        `SELECT id, list_price, currency FROM re_listings WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [id, orgId]
      );
      if (!existing.rows[0]) {
        return NextResponse.json({ error: 'Listing not found', invented: false }, { status: 404 });
      }

      const status =
        body.status === undefined ? null : String(body.status);
      if (status != null && !STATUSES.has(status)) {
        return NextResponse.json({ error: `Invalid status: ${status}` }, { status: 400 });
      }

      const listPriceRaw = body.list_price ?? body.price;
      const listPrice =
        listPriceRaw === undefined
          ? undefined
          : listPriceRaw == null || listPriceRaw === ''
            ? null
            : Number(listPriceRaw);
      if (listPrice !== undefined && listPrice != null && !Number.isFinite(listPrice)) {
        return NextResponse.json({ error: 'list_price must be a number' }, { status: 400 });
      }

      if (listPrice !== undefined && listPrice != null) {
        const old = Number(existing.rows[0].list_price);
        if (Number.isFinite(old) && old !== listPrice) {
          try {
            await client.query(
              `INSERT INTO re_listing_price_history (listing_id, org_id, old_price, new_price, currency)
               VALUES ($1, $2, $3, $4, $5)`,
              [id, orgId, old, listPrice, existing.rows[0].currency || 'INR']
            );
          } catch {
            // price history table may be missing pre-093
          }
        }
      }

      const amenities =
        body.amenities === undefined
          ? undefined
          : Array.isArray(body.amenities)
            ? body.amenities.map(String)
            : null;

      const res = await client.query(
        `UPDATE re_listings
            SET status = COALESCE($1, status),
                list_price = CASE WHEN $2::boolean THEN $3 ELSE list_price END,
                title = COALESCE($4, title),
                locality = COALESCE($5, locality),
                city = COALESCE($6, city),
                amenities = COALESCE($7::text[], amenities),
                address_line = COALESCE($8, address_line),
                updated_at = NOW()
          WHERE id = $9 AND org_id = $10
          RETURNING id, source, source_ref, title, locality, city, bhk, list_price, currency, status, amenities`,
        [
          status,
          listPrice !== undefined,
          listPrice === undefined ? null : listPrice,
          body.title != null ? String(body.title) : null,
          body.locality != null ? String(body.locality) : body.area != null ? String(body.area) : null,
          body.city != null ? String(body.city) : null,
          amenities ?? null,
          body.address_line != null || body.addressLine != null
            ? String(body.address_line || body.addressLine)
            : null,
          id,
          orgId,
        ]
      );
      realtimeHub.publish(orgId, { type: 'listing_updated', message: id });
      return NextResponse.json({ listing: res.rows[0], invented: false });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> | { id: string } }) {
  try {
    const { id } = await Promise.resolve(context.params);
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid listing id' }, { status: 400 });
    }
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `UPDATE re_listings
            SET status = 'withdrawn', updated_at = NOW()
          WHERE id = $1 AND org_id = $2
          RETURNING id, status`,
        [id, orgId]
      );
      if (!res.rows[0]) {
        return NextResponse.json({ error: 'Listing not found', invented: false }, { status: 404 });
      }
      realtimeHub.publish(orgId, { type: 'listing_updated', message: id });
      return NextResponse.json({ success: true, withdrawnId: id, listing: res.rows[0], invented: false });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth3 = scopedAuthErrorResponse(err);
    if (__scopedAuth3) return __scopedAuth3;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
