import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

type GrowthOpportunityPayload = {
  companyName: string;
  whyThisCompany: string;
  whyThisPerson: string;
  whyNow: string;
  [k: string]: unknown;
};

function isMissingTable(err: unknown, table?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && (!table || message.includes(table));
}

function asCard(metadata: unknown): GrowthOpportunityPayload | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const rec = metadata as Record<string, unknown>;
  const card = (rec.card && typeof rec.card === 'object' ? rec.card : rec) as Record<string, unknown>;
  const companyName = typeof card.companyName === 'string' ? card.companyName : null;
  const whyThisCompany =
    (typeof card.whyThisCompany === 'string' && card.whyThisCompany) ||
    (typeof card.whyCompany === 'string' && card.whyCompany) ||
    null;
  const whyThisPerson =
    (typeof card.whyThisPerson === 'string' && card.whyThisPerson) ||
    (typeof card.whyPerson === 'string' && card.whyPerson) ||
    null;
  const whyNow = typeof card.whyNow === 'string' ? card.whyNow : null;
  if (!companyName || !whyThisCompany || !whyThisPerson || !whyNow) return null;
  return {
    ...card,
    companyName,
    whyThisCompany,
    whyThisPerson,
    whyNow,
  } as GrowthOpportunityPayload;
}

async function countOrZero(
  client: Awaited<ReturnType<typeof getScopedClient>>['client'],
  sql: string,
  params: unknown[],
  table: string
): Promise<number> {
  try {
    const res = await client.query(sql, params);
    return parseInt(String(res.rows[0]?.count || '0'), 10);
  } catch (err: unknown) {
    if (isMissingTable(err, table)) return 0;
    throw err;
  }
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      let opportunities: Array<{ id: string; status: string; card: GrowthOpportunityPayload }> = [];
      try {
        const res = await client.query(
          `SELECT id, status, metadata
             FROM work_items
            WHERE org_id = $1
              AND type = 'growth_opportunity'
              AND status IN ('open', 'in_progress', 'needs_attention', 'waiting_approval')
            ORDER BY updated_at DESC
            LIMIT 50`,
          [orgId]
        );
        opportunities = res.rows
          .map((row: { id: string; status: string; metadata: unknown }) => {
            const card = asCard(row.metadata);
            if (!card) return null;
            return { id: row.id, status: row.status, card };
          })
          .filter((row): row is { id: string; status: string; card: GrowthOpportunityPayload } => Boolean(row));
      } catch (err: unknown) {
        if (!isMissingTable(err, 'work_items')) throw err;
      }

      const signalCount = await countOrZero(
        client,
        `SELECT COUNT(*) FROM lead_intent_signals WHERE org_id = $1 AND detected_at >= NOW() - INTERVAL '7 days'`,
        [orgId],
        'lead_intent_signals'
      );
      const visitorCount = await countOrZero(
        client,
        `SELECT COUNT(*) FROM visitor_company_intent WHERE org_id = $1`,
        [orgId],
        'visitor_company_intent'
      );

      let pipelineRoi: {
        rows: number;
        estimatedValueCents: number;
        byStage: Record<string, number>;
      } = { rows: 0, estimatedValueCents: 0, byStage: {} };
      try {
        const roi = await client.query<{ stage: string; n: string; value: string }>(
          `SELECT stage, COUNT(*)::text AS n, COALESCE(SUM(estimated_value_cents), 0)::text AS value
             FROM growth_pipeline_attribution
            WHERE org_id = $1
            GROUP BY stage`,
          [orgId],
        );
        for (const row of roi.rows) {
          const n = parseInt(row.n, 10) || 0;
          const value = parseInt(row.value, 10) || 0;
          pipelineRoi.rows += n;
          pipelineRoi.estimatedValueCents += value;
          pipelineRoi.byStage[row.stage] = value;
        }
      } catch (err: unknown) {
        if (!isMissingTable(err, 'growth_pipeline_attribution')) throw err;
      }

      return NextResponse.json({
        orgId,
        opportunities,
        signalCount,
        visitorCount,
        pipelineRoi,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingTable(error)) {
      return NextResponse.json({ opportunities: [], signalCount: 0, visitorCount: 0 });
    }
    console.error('GET /api/growth/brief Error:', error, message);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
