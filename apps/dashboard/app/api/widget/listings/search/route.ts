import { NextResponse } from 'next/server';
import { getOrgScopedClient } from '@/lib/db';
import {
  orgHasInstalledPack,
  requireWidgetOrg,
  widgetForbidden,
  widgetPreflight,
  withWidgetCors,
} from '../../_lib';

/**
 * GET /api/widget/listings/search
 * Pack-gated public listing search. Does not invent inventory. No admin APIs.
 */
export const dynamic = 'force-dynamic';

export async function OPTIONS(request: Request) {
  return widgetPreflight(request);
}

export async function GET(request: Request) {
  const auth = await requireWidgetOrg(request);
  if (!auth.ok) return auth.response;

  const pack = await orgHasInstalledPack(auth.orgId);
  if (!pack) {
    return withWidgetCors(
      request,
      widgetForbidden('Widget is deny-all until a pack is installed.'),
      auth.allowedOrigins
    );
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
  const { client } = await getOrgScopedClient(auth.orgId);
  try {
    const params: unknown[] = [auth.orgId];
    let sql = `
      SELECT id, title, locality, city, bhk, list_price, currency, rera_id, status, source, source_ref
        FROM re_listings
       WHERE org_id = $1
         AND status IN ('active', 'under_offer', 'reserved')
    `;
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (
        COALESCE(title, '') ILIKE $2
        OR COALESCE(locality, '') ILIKE $2
        OR COALESCE(city, '') ILIKE $2
        OR COALESCE(source_ref, '') ILIKE $2
      )`;
    }
    sql += ` ORDER BY updated_at DESC LIMIT 20`;
    const res = await client.query(sql, params);
    return withWidgetCors(
      request,
      NextResponse.json({
        listings: res.rows,
        count: res.rows.length,
        invented: false,
      }),
      auth.allowedOrigins
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[widget listings.search]', message);
    return withWidgetCors(
      request,
      NextResponse.json({ listings: [], count: 0, invented: false }),
      auth.allowedOrigins
    );
  } finally {
    client.release();
  }
}
