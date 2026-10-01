import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canDisableEmployee, loadHumanRole } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

function isMissing(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  return code === '42P01' || /does not exist|relation|column/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * POST /api/growth/listings/match
 *
 * Match recent re_listings to open re_inquiries and create growth_opportunity
 * work items for human approval. Never sends messages automatically.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canDisableEmployee(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      let listings: Array<{
        id: string;
        title: string | null;
        bhk: number | null;
        locality: string | null;
        list_price: string | null;
      }> = [];
      try {
        const listingRes = await client.query(
          `SELECT id, title, bhk, locality, list_price
             FROM re_listings
            WHERE org_id = $1 AND status IN ('active', 'under_offer', 'reserved')
            ORDER BY updated_at DESC
            LIMIT 20`,
          [orgId],
        );
        listings = listingRes.rows;
      } catch (err) {
        if (isMissing(err)) {
          return NextResponse.json({
            ok: true,
            matched: 0,
            createdWorkItems: [],
            message: 're_listings table not available',
          });
        }
        throw err;
      }

      const createdWorkItems: string[] = [];
      let matched = 0;

      for (const listing of listings) {
        let inquiries: Array<{ id: string; contact_id: string | null; channel: string | null; name?: string }> = [];
        try {
          const inq = await client.query(
            `SELECT id, contact_id, channel, COALESCE(payload->>'name', contact_id) AS name
               FROM re_inquiries
              WHERE org_id = $1
                AND status IN ('new', 'contacted')
                AND (bhk IS NULL OR $2::int IS NULL OR bhk = $2)
                AND (budget_max IS NULL OR $3::numeric IS NULL OR budget_max >= $3::numeric)
              ORDER BY updated_at DESC
              LIMIT 5`,
            [orgId, listing.bhk, listing.list_price],
          );
          inquiries = inq.rows;
        } catch (err) {
          if (isMissing(err)) break;
          throw err;
        }

        for (const inq of inquiries) {
          matched += 1;
          const card = {
            companyName: listing.title || `Listing ${listing.id.slice(0, 8)}`,
            whyThisCompany: `Listing in ${listing.locality || 'your area'}${listing.bhk ? ` (${listing.bhk} BHK)` : ''}`,
            whyThisPerson: `Inquiry ${inq.id.slice(0, 8)} matched on BHK/budget filters`,
            whyNow: 'New or updated listing matches an open inquiry — draft only until you approve.',
            listingId: listing.id,
            inquiryId: inq.id,
            targetContact: {
              name: inq.name || inq.contact_id || 'Lead',
              email: typeof inq.contact_id === 'string' && inq.contact_id.includes('@') ? inq.contact_id : undefined,
            },
            draftedMessage: {
              subject: `A property matching your search: ${listing.title || 'new listing'}`,
              body: `Hi${inq.name ? ` ${inq.name}` : ''},\n\nA property that may match your search was listed: ${listing.title || 'new listing'} in ${listing.locality || 'your preferred area'}${listing.list_price ? ` (listed around ${listing.list_price})` : ''}.\n\nWould you like to schedule a tour?\n`,
            },
          };

          const inserted = await client.query<{ id: string }>(
            `INSERT INTO work_items (org_id, type, status, source, priority, metadata, payload)
             VALUES ($1, 'growth_opportunity', 'waiting_approval', 'growth_listing_match', 'normal', $2::jsonb, $2::jsonb)
             RETURNING id`,
            [orgId, JSON.stringify({ card, recommendedAction: 'send_outreach', requiresHumanApproval: true })],
          );
          if (inserted.rows[0]?.id) createdWorkItems.push(inserted.rows[0].id);
        }
      }

      return NextResponse.json({
        ok: true,
        matched,
        createdWorkItems,
        message:
          createdWorkItems.length > 0
            ? 'Matches queued as opportunity cards — outreach requires explicit Approve'
            : 'No new listing/inquiry matches',
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('POST /api/growth/listings/match Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
