import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';

export const dynamic = 'force-dynamic';

function missingTables(message: string): boolean {
  return /re_listings|does not exist|relation/i.test(message);
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

      const params: unknown[] = [orgId];
      let sql = `
        SELECT id, source, source_ref, title, locality, city, bhk, list_price, currency,
               rera_id, status, last_source_sync_at
          FROM re_listings
         WHERE org_id = $1`;
      let i = 2;
      const searching = Boolean(bhk || locality || city || maxPrice);
      if (searching) {
        sql += ` AND status IN ('active', 'under_offer', 'stale')`;
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
        sql += ` AND (locality ILIKE $${i} OR city ILIKE $${i})`;
        params.push(`%${locality}%`);
        i += 1;
      }
      if (city) {
        sql += ` AND city ILIKE $${i}`;
        params.push(`%${city}%`);
        i += 1;
      }
      if (maxPrice) {
        const raw = String(maxPrice).trim().toLowerCase().replace(/,/g, '');
        const cr = raw.match(/^([\d.]+)\s*(cr|crore)s?$/);
        const lakh = raw.match(/^([\d.]+)\s*(l|lac|lakh)s?$/);
        const n = cr
          ? Math.round(parseFloat(cr[1]) * 10_000_000)
          : lakh
            ? Math.round(parseFloat(lakh[1]) * 100_000)
            : Number(raw);
        if (Number.isFinite(n)) {
          sql += ` AND list_price IS NOT NULL AND list_price <= $${i}`;
          params.push(n);
        }
      }
      sql += ` ORDER BY updated_at DESC LIMIT 200`;

      const res = await client.query(sql, params);
      return NextResponse.json({
        orgId,
        listings: res.rows.map((row) => ({
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
      return NextResponse.json({ listings: [], invented: false, error: '015_packs.sql not applied' }, { status: 200 });
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
           title = EXCLUDED.title,
           locality = EXCLUDED.locality,
           city = EXCLUDED.city,
           bhk = EXCLUDED.bhk,
           list_price = EXCLUDED.list_price,
           currency = EXCLUDED.currency,
           rera_id = EXCLUDED.rera_id,
           status = EXCLUDED.status,
           last_source_sync_at = NOW(),
           updated_at = NOW()
         RETURNING id, source, source_ref, title, locality, city, bhk, list_price, status`,
        [
          orgId,
          String(body.source || 'csv'),
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
      return NextResponse.json({ listing: res.rows[0], invented: false });
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
