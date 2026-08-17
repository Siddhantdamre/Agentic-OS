import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT id, listing_id, contact_id, channel, status, bhk, locality, city,
                budget_max, currency, updated_at
           FROM re_inquiries
          WHERE org_id = $1
          ORDER BY updated_at DESC
          LIMIT 200`,
        [orgId]
      );
      return NextResponse.json({
        orgId,
        inquiries: res.rows.map((row) => ({
          id: row.id,
          type: 're.inquiry',
          listingRef: row.listing_id,
          contact: row.contact_id,
          contact_id: row.contact_id,
          channel: row.channel,
          status: row.status,
          bhk: row.bhk,
          locality: row.locality,
          updatedAt: row.updated_at,
          updated_at: row.updated_at,
        })),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/re_inquiries|does not exist|relation/i.test(message)) {
      return NextResponse.json({ inquiries: [] });
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
      const res = await client.query(
        `INSERT INTO re_inquiries (
           org_id, listing_id, contact_id, channel, status, bhk, locality, city, budget_max, currency, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING id, status, created_at`,
        [
          orgId,
          body.listingId || body.listing_id || null,
          body.contact || body.contact_id || body.contactId || null,
          body.channel || null,
          body.status || 'new',
          body.bhk == null || body.bhk === '' ? null : Number(body.bhk),
          body.locality || body.area || null,
          body.city || null,
          body.budget_max || body.budgetMax || null,
          body.currency || 'INR',
          JSON.stringify({ via: 'api' }),
        ]
      );
      return NextResponse.json({ inquiry: res.rows[0] });
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
