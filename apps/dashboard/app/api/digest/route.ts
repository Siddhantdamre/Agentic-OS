import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { buildDigest } from '@/lib/owner-digest';

export const dynamic = 'force-dynamic';

/**
 * The owner's daily summary: counts for the last 24 hours (and the next 24 for showings), turned into plain
 * sentences by buildDigest. Every query is limited to the signed-in workspace.
 */
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const one = async (sql: string): Promise<number> => {
        const res = await client.query(sql, [orgId]);
        return Number(res.rows[0]?.n || 0);
      };
      const answered = await one(
        `SELECT count(*)::text AS n FROM messages
          WHERE org_id = $1 AND role = 'assistant' AND COALESCE(is_internal, false) = false
            AND created_at > NOW() - INTERVAL '24 hours'`
      );
      const sent = await one(
        `SELECT count(*)::text AS n FROM agent_pending_actions
          WHERE org_id = $1 AND status = 'executed' AND executed_at > NOW() - INTERVAL '24 hours'`
      );
      const waiting = await one(
        `SELECT count(*)::text AS n FROM agent_pending_actions
          WHERE org_id = $1 AND status = 'pending' AND (expires_at IS NULL OR expires_at > NOW())`
      );
      const newInquiries = await one(
        `SELECT count(*)::text AS n FROM re_inquiries
          WHERE org_id = $1 AND deleted_at IS NULL AND created_at > NOW() - INTERVAL '24 hours'`
      );
      const showingsSoon = await one(
        `SELECT count(*)::text AS n FROM re_showings
          WHERE org_id = $1 AND status <> 'cancelled'
            AND starts_at >= NOW() AND starts_at < NOW() + INTERVAL '24 hours'`
      );
      const counts = { answered, sent, waiting, newInquiries, showingsSoon };
      return NextResponse.json({ orgId, counts, digest: buildDigest(counts) });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/digest Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
