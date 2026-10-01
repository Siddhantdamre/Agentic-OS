import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import {
  listKnowledgeGapClustersActivity,
  type KnowledgeGapCluster,
} from '@darex/workflows/dist/activities/customer';

export const dynamic = 'force-dynamic';

function isMissing(err: unknown): boolean {
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  return code === '42P01' || /does not exist|relation|column/i.test(err instanceof Error ? err.message : String(err));
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limitRaw = parseInt(searchParams.get('limit') || '25', 10);
    const offsetRaw = parseInt(searchParams.get('offset') || '0', 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 25, 1), 100);
    const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

    const { client, orgId } = await getScopedClient();
    try {
      let handled = 0;
      let atRisk = 0;
      try {
        const conversations = await client.query<{ handled: string; at_risk: string }>(
          `SELECT COUNT(*)::text AS handled,
                  COUNT(*) FILTER (
                    WHERE customer_operational_state IN ('at_risk', 'frustrated', 'unresolved')
                       OR status = 'needs_attention'
                  )::text AS at_risk
             FROM conversations
            WHERE org_id = $1 AND updated_at > NOW() - INTERVAL '7 days'`,
          [orgId],
        );
        handled = Number(conversations.rows[0]?.handled || 0);
        atRisk = Number(conversations.rows[0]?.at_risk || 0);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }

      let openLoops = 0;
      try {
        const loops = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM agent_open_loops
            WHERE org_id = $1 AND status NOT IN ('closed')`,
          [orgId],
        );
        openLoops = Number(loops.rows[0]?.n || 0);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }

      let cards: Array<Record<string, unknown>> = [];
      let cardsTotal = 0;
      try {
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM work_items
            WHERE org_id = $1 AND status IN ('needs_attention', 'waiting_approval', 'open')
              AND (metadata ? 'card' OR payload ? 'card')`,
          [orgId],
        );
        cardsTotal = Number(countRes.rows[0]?.n || 0);
        const items = await client.query(
          `SELECT id, status, metadata, payload, conversation_id, updated_at FROM work_items
            WHERE org_id = $1 AND status IN ('needs_attention', 'waiting_approval', 'open')
              AND (metadata ? 'card' OR payload ? 'card')
            ORDER BY updated_at DESC
            LIMIT $2 OFFSET $3`,
          [orgId, limit, offset],
        );
        cards = items.rows.map((row) => {
          const metadata = (row.metadata || {}) as Record<string, unknown>;
          const payload = (row.payload || {}) as Record<string, unknown>;
          const conversationId =
            (typeof row.conversation_id === 'string' && row.conversation_id) ||
            (typeof metadata.conversationId === 'string' && metadata.conversationId) ||
            (typeof payload.conversationId === 'string' && payload.conversationId) ||
            null;
          return {
            id: row.id,
            status: row.status,
            card: metadata.card || payload.card || null,
            conversationId,
            updatedAt: row.updated_at,
          };
        });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }

      let insights: Array<Record<string, unknown>> = [];
      try {
        const insightRows = await client.query(
          `SELECT id, topic, sample_count, recommendation, window_end
             FROM conversational_insights WHERE org_id = $1 ORDER BY created_at DESC LIMIT 6`,
          [orgId],
        );
        insights = insightRows.rows.map((row) => ({
          id: row.id, topic: row.topic, sampleCount: row.sample_count,
          recommendation: row.recommendation, windowEnd: row.window_end,
        }));
      } catch (err) {
        if (!isMissing(err)) throw err;
      }

      let knowledgeGaps: { clusters: KnowledgeGapCluster[]; totalQuestions: number } = {
        clusters: [],
        totalQuestions: 0,
      };
      try {
        const result = await listKnowledgeGapClustersActivity({ orgId, limit: 500 });
        knowledgeGaps = { clusters: result.clusters, totalQuestions: result.totalQuestions };
      } catch (err) {
        if (!isMissing(err)) throw err;
      }

      return NextResponse.json({
        orgId,
        handled,
        atRisk,
        openLoops,
        attention: cardsTotal,
        cards,
        cardsTotal,
        cardsLimit: limit,
        cardsOffset: offset,
        cardsHasMore: offset + cards.length < cardsTotal,
        insights,
        knowledgeGaps,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
