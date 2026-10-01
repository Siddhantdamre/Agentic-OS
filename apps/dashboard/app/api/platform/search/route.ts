import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/platform-admin';
import {
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';

export const dynamic = 'force-dynamic';

const SEARCH_CAP = 50;

/**
 * GET /api/platform/search?q= — email prefix, org name/slug substring, connector id.
 * Cap 50. Audited as platform.search.
 */
export async function GET(request: Request) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;

    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) {
      return NextResponse.json({ error: 'q required' }, { status: 400 });
    }

    const reason = q.length > 200 ? q.slice(0, 200) : q;

    const results = await withPlatformTransaction(
      {
        actorUserId: admin.userId,
        platformRole: admin.platformRole,
        action: 'platform.search',
        reason,
      },
      async (client) => {
        const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
        const prefix = `${q.replace(/[%_]/g, '\\$&')}%`;

        const res = await client.query<{
          id: string;
          name: string;
          slug: string;
          status: string;
          plan: string;
          match_via: string;
        }>(
          `WITH matched AS (
             SELECT o.id, o.name, o.slug, o.status, o.plan, 'org'::text AS match_via
               FROM orgs o
              WHERE o.name ILIKE $1 ESCAPE '\\'
                 OR o.slug ILIKE $1 ESCAPE '\\'
             UNION
             SELECT o.id, o.name, o.slug, o.status, o.plan, 'email'::text AS match_via
               FROM users u
               JOIN organization_memberships om ON om.user_id = u.id
               JOIN orgs o ON o.id = om.org_id
              WHERE u.email ILIKE $2 ESCAPE '\\'
             UNION
             SELECT o.id, o.name, o.slug, o.status, o.plan, 'connector'::text AS match_via
               FROM org_connectors oc
               JOIN orgs o ON o.id = oc.org_id
              WHERE oc.nango_connection_id ILIKE $1 ESCAPE '\\'
                 OR oc.connector_key ILIKE $1 ESCAPE '\\'
                 OR oc.id::text = $3
           )
           SELECT DISTINCT ON (id) id, name, slug, status, plan, match_via
             FROM matched
            ORDER BY id, match_via
            LIMIT $4`,
          [like, prefix, q, SEARCH_CAP]
        );

        return res.rows.map((row) => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          status: row.status,
          plan: row.plan,
          matchVia: row.match_via,
          // Search cards are org summaries — health unknown (no snapshot join).
          health: 'unknown' as const,
          healthAlertCount: null,
        }));
      }
    );

    return NextResponse.json({
      orgs: results,
      results,
      cap: SEARCH_CAP,
      q: reason,
    });
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('GET /api/platform/search', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
