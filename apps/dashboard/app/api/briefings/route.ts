import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

/**
 * GET /api/briefings — the reports the agents produced on their own.
 *
 * OwnerBriefingWorkflow has always persisted its result to channel_logs as an
 * OWNER_BRIEFING row, and no screen has ever read one. That combination — the
 * work happens, the record is written, nobody can see it — is the recurring
 * failure in this codebase, and here it was total: the table held zero rows
 * because nothing had ever started the workflow either.
 *
 * The payload is written by persistBriefingActivity and carries the metric
 * points, the knowledge gaps, the narrative and the needs-attention count.
 * Nothing here recomputes any of that: this route reports what the agent
 * actually said at the time it said it, which is the point of a briefing.
 */
export async function GET(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const url = new URL(request.url);
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 7));

      const res = await client.query(
        `SELECT id, created_at, message, payload
           FROM channel_logs
          WHERE org_id = $1 AND event_type = 'OWNER_BRIEFING'
          ORDER BY created_at DESC
          LIMIT $2`,
        [orgId, limit]
      );

      const briefings = res.rows.map((row: any) => {
        const p = (row.payload || {}) as Record<string, unknown>;
        return {
          id: row.id,
          // generatedAt is stamped by the workflow; created_at is when the row
          // landed. They agree, but the workflow's own timestamp is the truth
          // about when the agent looked.
          at: (p.generatedAt as string) || row.created_at,
          narrative: (p.narrative as string) || row.message || '',
          needsAttention: Number(p.needsAttentionCount ?? 0),
          points: Array.isArray(p.points) ? p.points : [],
          gaps: Array.isArray(p.gaps) ? p.gaps : [],
        };
      });

      return NextResponse.json({ briefings });
    } finally {
      client.release();
    }
  } catch (error: any) {
    if (error?.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[briefings]', error);
    return NextResponse.json({ error: 'Could not load briefings.' }, { status: 500 });
  }
}
