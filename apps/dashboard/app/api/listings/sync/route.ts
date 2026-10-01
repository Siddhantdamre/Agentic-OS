import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { realtimeHub } from '@/lib/realtime-hub';

export const dynamic = 'force-dynamic';

function missingTables(message: string): boolean {
  return /re_listings|does not exist|relation/i.test(message);
}

type ListingSyncRow = {
  source: string;
  sourceRef: string;
  title: string | null;
  locality: string | null;
  city: string | null;
  bhk: number | null;
  listPrice: number | null;
  currency: string;
  reraId: string | null;
  status: string;
  payload: Record<string, unknown>;
};

/**
 * POST /api/listings/sync
 *
 * Idempotent upsert into re_listings on (org_id, source, source_ref).
 * Accepts an explicit listings[] payload only — never invents inventory.
 * Provider pull (MLS API) is Partial: no licensed MLS client is wired in-repo.
 */
export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected, invented: false }, { status: 400 });
      }

      const mode = String(body.mode || body.action || 'upsert').toLowerCase();
      const provider = String(body.provider || body.source || 'mls').trim().toLowerCase() || 'mls';

      // No real MLS/API feed client exists in services/connectors — refuse fabricated pulls.
      if (mode === 'pull' || mode === 'fetch' || body.pull === true) {
        return NextResponse.json(
          {
            ok: false,
            invented: false,
            upserted: 0,
            provider,
            providerPull: 'partial',
            error:
              'No licensed MLS API client is configured. Push known listings via listings[] for idempotent upsert, or connect a sheet sync — Darex will not invent inventory.',
          },
          { status: 501 }
        );
      }

      const rawList =
        Array.isArray(body.listings) ? body.listings
        : Array.isArray(body.properties) ? body.properties
        : Array.isArray(body.rows) ? body.rows
        : null;

      if (!rawList) {
        return NextResponse.json(
          {
            error:
              'listings[] is required for sync upsert. Each row needs sourceRef (or source_ref). Darex will not invent listing ids.',
            invented: false,
            providerPull: provider === 'mls' ? 'partial' : undefined,
          },
          { status: 400 }
        );
      }

      if (rawList.length === 0) {
        return NextResponse.json({
          ok: true,
          invented: false,
          upserted: 0,
          listings: [],
          provider,
          providerPull: provider === 'mls' ? 'partial' : undefined,
          message: 'Empty listings[] — nothing to upsert.',
        });
      }

      const rows: ListingSyncRow[] = [];
      const errors: string[] = [];
      for (let i = 0; i < rawList.length; i += 1) {
        const item = rawList[i];
        if (!item || typeof item !== 'object') {
          errors.push(`row ${i}: must be an object`);
          continue;
        }
        const rec = item as Record<string, unknown>;
        const sourceRef = String(rec.sourceRef || rec.source_ref || rec.id || '').trim();
        if (!sourceRef) {
          errors.push(`row ${i}: sourceRef is required (will not invent)`);
          continue;
        }
        const listPriceRaw = rec.list_price ?? rec.price ?? rec.listPrice;
        const listPrice =
          listPriceRaw == null || listPriceRaw === ''
            ? null
            : Number(listPriceRaw);
        rows.push({
          source: String(rec.source || provider || 'mls').trim() || 'mls',
          sourceRef,
          title: rec.title || rec.name ? String(rec.title || rec.name) : null,
          locality: rec.locality || rec.area ? String(rec.locality || rec.area) : null,
          city: rec.city ? String(rec.city) : null,
          bhk: rec.bhk == null || rec.bhk === '' ? null : Number(rec.bhk),
          listPrice: listPrice != null && Number.isFinite(listPrice) ? listPrice : null,
          currency: String(rec.currency || 'INR'),
          reraId: rec.rera_id || rec.reraId ? String(rec.rera_id || rec.reraId) : null,
          status: String(rec.status || 'active'),
          payload: { via: 'listings_sync', provider, rawKeys: Object.keys(rec) },
        });
      }

      if (rows.length === 0) {
        return NextResponse.json(
          { error: 'No valid listing rows to upsert', errors, invented: false, upserted: 0 },
          { status: 400 }
        );
      }

      const payloadRows = rows.map((row) => ({
        source: row.source,
        source_ref: row.sourceRef,
        title: row.title,
        locality: row.locality,
        city: row.city,
        bhk: row.bhk != null && Number.isFinite(row.bhk) ? row.bhk : null,
        list_price: row.listPrice,
        currency: row.currency,
        rera_id: row.reraId,
        status: row.status,
        payload: row.payload,
      }));

      const res = await client.query(
        `INSERT INTO re_listings (
           org_id, source, source_ref, title, locality, city, bhk, list_price, currency,
           rera_id, status, last_source_sync_at, payload
         )
         SELECT $1,
                x.source, x.source_ref, x.title, x.locality, x.city, x.bhk, x.list_price,
                x.currency, x.rera_id, x.status, NOW(), x.payload
           FROM jsonb_to_recordset($2::jsonb) AS x(
             source text, source_ref text, title text, locality text, city text,
             bhk integer, list_price numeric, currency text, rera_id text, status text, payload jsonb
           )
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
           payload = EXCLUDED.payload,
           updated_at = NOW()
         RETURNING id, source, source_ref, title, locality, city, bhk, list_price, status`,
        [orgId, JSON.stringify(payloadRows)]
      );

      if (res.rows.length > 0) realtimeHub.publish(orgId, { type: 'listing_updated', message: `sync:${res.rows.length}` });
      return NextResponse.json({
        ok: true,
        invented: false,
        upserted: res.rows.length,
        listings: res.rows,
        errors: errors.length ? errors : undefined,
        provider,
        providerPull: provider === 'mls' ? 'partial' : undefined,
        message:
          provider === 'mls'
            ? `Upserted ${res.rows.length} listing(s) idempotently (batch). MLS provider pull remains Partial (no API client wired).`
            : `Upserted ${res.rows.length} listing(s) idempotently (batch).`,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json(
        { error: '015_packs.sql not applied', invented: false, upserted: 0 },
        { status: 503 }
      );
    }
    console.error('API POST /api/listings/sync', err);
    return NextResponse.json({ error: 'Internal Server Error', invented: false }, { status: 500 });
  }
}
