import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/knowledge-gaps — what the agent could not answer, ranked.
 *
 * WHY THIS EXISTS
 * Migration 025 has recorded every unanswerable question since it shipped, and
 * WorkItemWorkflow writes to it from two live call sites. Nothing read it. No
 * API route, no page — the agent diligently kept a list of everything it did
 * not know, in a table no human could see.
 *
 * That list is the single most actionable thing this product produces. It is
 * not a bug report; it is a business telling you, in its customers' own words
 * and with a count attached, exactly which twelve facts would make its AI
 * employee useful. Answering one takes a minute and permanently removes a
 * class of failure.
 *
 * Ordered by times_asked, because the count IS the priority: a question asked
 * forty times is worth answering before one asked once, and no other ranking
 * signal comes close.
 */
export async function GET(request: Request) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || 'open';
    if (!['open', 'resolved', 'dismissed'].includes(status)) {
      return NextResponse.json({ error: 'Unknown status filter.' }, { status: 400 });
    }

    const res = await client.query(
      `SELECT id, question, agent_reply, times_asked, status,
              first_seen_at, last_seen_at, memory_id
         FROM knowledge_gaps
        WHERE org_id = $1 AND status = $2
        ORDER BY times_asked DESC, last_seen_at DESC
        LIMIT 100`,
      [orgId, status],
    );

    const openCount = await client.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(times_asked), 0)::int AS asked
         FROM knowledge_gaps WHERE org_id = $1 AND status = 'open'`,
      [orgId],
    );

    return NextResponse.json({
      gaps: res.rows.map((r) => ({
        id: r.id,
        question: r.question,
        agentReply: r.agent_reply,
        timesAsked: r.times_asked,
        status: r.status,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        memoryId: r.memory_id,
      })),
      // Headline numbers for the page: how many distinct things the agent does
      // not know, and how many customer questions those gaps have cost so far.
      openGaps: openCount.rows[0]?.n ?? 0,
      questionsMissed: openCount.rows[0]?.asked ?? 0,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[knowledge-gaps]', message);
    return NextResponse.json({ error: 'Could not load knowledge gaps.' }, { status: 500 });
  } finally {
    client.release();
  }
}
