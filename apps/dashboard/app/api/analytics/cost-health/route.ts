import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

function emptyPayload(orgId: string, tablesReady: boolean) {
  return {
    orgId,
    windowDays: 7,
    modelCalls: null as number | null,
    spendCents: null as number | null,
    sweepModelCalls: null as number | null,
    sweepShare: null as number | null,
    idleSweepPasses: null as number | null,
    busySweepPasses: null as number | null,
    costPerObligationCents: null as number | null,
    escalateOnly: null as boolean | null,
    maxSpendCentsPerDay: null as number | null,
    healthy: null as boolean | null,
    hasData: false,
    tablesReady,
  };
}

export async function GET() {
  let scoped: Awaited<ReturnType<typeof getScopedClient>> | null = null;
  try {
    scoped = await getScopedClient();
    const { client, orgId } = scoped;
    try {
      const res = await client.query(
        `SELECT COUNT(*)::int AS row_count,
                COALESCE(SUM(model_calls),0) AS model_calls,
                COALESCE(SUM(spend_cents),0) AS spend_cents,
                COALESCE(SUM(sweep_model_calls),0) AS sweep_model_calls,
                COALESCE(SUM(obligations_extracted),0) AS obligations_extracted,
                COALESCE(SUM(idle_sweep_passes),0) AS idle_sweep_passes,
                COALESCE(SUM(busy_sweep_passes),0) AS busy_sweep_passes
           FROM org_model_spend
          WHERE org_id = $1 AND spend_date >= CURRENT_DATE - INTERVAL '7 days'`,
        [orgId]
      );
      const row = res.rows[0] || {};
      const rowCount = Number(row.row_count ?? 0);
      if (rowCount === 0) {
        // No spend rows in window — never invent a healthy zero.
        let escalateOnly: boolean | null = null;
        let maxSpendCentsPerDay: number | null = null;
        try {
          const ceiling = await client.query(
            `SELECT escalate_only, max_spend_cents_per_day FROM org_cost_ceilings WHERE org_id = $1`,
            [orgId]
          );
          if (ceiling.rows[0]) {
            escalateOnly = Boolean(ceiling.rows[0].escalate_only);
            maxSpendCentsPerDay = Number(ceiling.rows[0].max_spend_cents_per_day ?? 2500);
          }
        } catch (ceilErr) {
          if ((ceilErr as { code?: string })?.code !== '42P01') throw ceilErr;
        }
        return NextResponse.json({
          ...emptyPayload(orgId, true),
          escalateOnly,
          maxSpendCentsPerDay,
        });
      }

      const modelCalls = Number(row.model_calls ?? 0);
      const sweepCalls = Number(row.sweep_model_calls ?? 0);
      const obligations = Number(row.obligations_extracted ?? 0);
      const spendCents = Number(row.spend_cents ?? 0);
      const ceiling = await client.query(
        `SELECT escalate_only, max_spend_cents_per_day FROM org_cost_ceilings WHERE org_id = $1`,
        [orgId]
      );
      const sweepShare = modelCalls === 0 ? null : sweepCalls / modelCalls;
      return NextResponse.json({
        orgId,
        windowDays: 7,
        modelCalls,
        spendCents,
        sweepModelCalls: sweepCalls,
        sweepShare,
        idleSweepPasses: Number(row.idle_sweep_passes ?? 0),
        busySweepPasses: Number(row.busy_sweep_passes ?? 0),
        costPerObligationCents: obligations === 0 ? null : spendCents / obligations,
        escalateOnly: Boolean(ceiling.rows[0]?.escalate_only),
        maxSpendCentsPerDay: Number(ceiling.rows[0]?.max_spend_cents_per_day ?? 2500),
        healthy: sweepShare == null ? null : sweepShare < 0.1,
        hasData: true,
        tablesReady: true,
      });
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01') {
        return NextResponse.json(emptyPayload(orgId, false));
      }
      throw err;
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/analytics/cost-health Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    scoped?.client.release();
  }
}
