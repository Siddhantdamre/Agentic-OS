import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { realtimeHub } from '@/lib/realtime-hub';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

function missingTables(message: string): boolean {
  return /re_listings|does not exist|relation/i.test(message);
}

function parseMaxPrice(rawIn: string): number | null {
  const raw = String(rawIn).trim().toLowerCase().replace(/,/g, '');
  const cr = raw.match(/^([\d.]+)\s*(cr|crore)s?$/);
  const lakh = raw.match(/^([\d.]+)\s*(l|lac|lakh)s?$/);
  const n = cr
    ? Math.round(parseFloat(cr[1]) * 10_000_000)
    : lakh
      ? Math.round(parseFloat(lakh[1]) * 100_000)
      : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function GET(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { searchParams } = new URL(request.url);
      const bhk = searchParams.get('bhk');
      const locality = searchParams.get('locality') || searchParams.get('area');
      const city = searchParams.get('city');
      const maxPrice = searchParams.get('maxPrice') || searchParams.get('under');
      const currency = searchParams.get('currency');
      const cursor = searchParams.get('cursor');
      const limitRaw = parseInt(searchParams.get('limit') || '50', 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

      const params: unknown[] = [orgId];
      let sql = `
        SELECT id, source, source_ref, title, locality, city, bhk, list_price, currency,
               rera_id, status, last_source_sync_at, updated_at
          FROM re_listings
         WHERE org_id = $1`;
      let i = 2;
      const searching = Boolean(bhk || locality || city || maxPrice);
      if (searching) {
        sql += ` AND status IN ('active', 'under_offer', 'stale')`;
      }
      if (currency) {
        sql += ` AND currency = $${i}`;
        params.push(currency.toUpperCase());
        i += 1;
      }
      if (bhk) {
        const bhkN = parseInt(bhk, 10);
        if (Number.isInteger(bhkN)) {
          sql += ` AND bhk = $${i}`;
          params.push(bhkN);
          i += 1;
        }
      }
      if (locality) {
        // Escape LIKE metacharacters so %/_ in locality are literal.
        const escaped = locality.replace(/([\\%_])/g, '\\$1');
        sql += ` AND (locality ILIKE $${i} ESCAPE '\\' OR city ILIKE $${i} ESCAPE '\\')`;
        params.push(`%${escaped}%`);
        i += 1;
      }
      if (city) {
        const escaped = city.replace(/([\\%_])/g, '\\$1');
        sql += ` AND city ILIKE $${i} ESCAPE '\\'`;
        params.push(`%${escaped}%`);
        i += 1;
      }
      if (maxPrice) {
        const n = parseMaxPrice(maxPrice);
        if (n != null) {
          sql += ` AND list_price IS NOT NULL AND list_price <= $${i}`;
          params.push(n);
          i += 1;
        }
      }
      if (cursor) {
        sql += ` AND updated_at < $${i}::timestamptz`;
        params.push(cursor);
        i += 1;
      }
      sql += ` ORDER BY updated_at DESC LIMIT $${i}`;
      params.push(limit + 1);

      const res = await client.query(sql, params);
      const hasMore = res.rows.length > limit;
      const listings = (hasMore ? res.rows.slice(0, limit) : res.rows).map((row) => ({
        id: row.id,
        source: row.source,
        sourceRef: row.source_ref,
        title: row.title,
        locality: row.locality,
        city: row.city,
        area: row.locality,
        bhk: row.bhk,
        list_price: row.list_price,
        price: row.list_price,
        currency: row.currency,
        rera_id: row.rera_id,
        status: row.status,
        last_source_sync_at: row.last_source_sync_at,
        updated_at: row.updated_at,
      }));
      const nextCursor = hasMore ? listings[listings.length - 1]?.updated_at ?? null : null;

      return NextResponse.json({
        orgId,
        listings,
        nextCursor,
        hasMore,
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
      return NextResponse.json({ listings: [], invented: false, error: '015_packs.sql not applied' }, { status: 200 });
    }
    console.error('GET /api/listings Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }
      const sourceRef = String(body.sourceRef || body.source_ref || body.id || '').trim();
      if (!sourceRef) {
        return NextResponse.json(
          { error: 'sourceRef is required. Darex will not invent a listing id.' },
          { status: 400 }
        );
      }
      const listPriceRaw = body.list_price ?? body.price;
      const listPrice =
        listPriceRaw == null || listPriceRaw === ''
          ? null
          : Number(listPriceRaw);
      const res = await client.query(
        `INSERT INTO re_listings (
           org_id, source, source_ref, title, locality, city, bhk, list_price, currency,
           rera_id, status, last_source_sync_at, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12::jsonb)
         ON CONFLICT (org_id, source, source_ref) DO UPDATE SET
           title = COALESCE(EXCLUDED.title, re_listings.title),
           locality = COALESCE(EXCLUDED.locality, re_listings.locality),
           city = COALESCE(EXCLUDED.city, re_listings.city),
           bhk = COALESCE(EXCLUDED.bhk, re_listings.bhk),
           list_price = COALESCE(EXCLUDED.list_price, re_listings.list_price),
           currency = COALESCE(EXCLUDED.currency, re_listings.currency),
           rera_id = COALESCE(EXCLUDED.rera_id, re_listings.rera_id),
           status = COALESCE(EXCLUDED.status, re_listings.status),
           last_source_sync_at = NOW(),
           updated_at = NOW()
         RETURNING id, source, source_ref, title, locality, city, bhk, list_price, status`,
        [
          orgId,
          String(body.source || 'manual_entry'),
          sourceRef,
          body.title || body.name || null,
          body.locality || body.area || null,
          body.city || null,
          body.bhk == null || body.bhk === '' ? null : Number(body.bhk),
          listPrice != null && Number.isFinite(listPrice) ? listPrice : null,
          body.currency || 'INR',
          body.rera_id || body.reraId || null,
          body.status || 'active',
          JSON.stringify({ via: 'api' }),
        ]
      );
      realtimeHub.publish(orgId, { type: 'listing_updated', message: String(res.rows[0]?.id ?? '') });
      return NextResponse.json({ listing: res.rows[0], invented: false });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('POST /api/listings Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
