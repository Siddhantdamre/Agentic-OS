import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';

function isMissingTable(err: unknown, table?: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && (!table || message.includes(table));
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      let pipeline: Array<Record<string, unknown>> = [];
      let hoursByRole: Array<{ employeeRole: string; hoursSaved: number }> = [];
      let pipelineReady = true;
      let hoursReady = true;

      try {
        const attr = await client.query(
          `SELECT opportunity_work_item_id, crm_deal_id, stage, estimated_value_cents, currency
             FROM growth_pipeline_attribution
            WHERE org_id = $1
            ORDER BY estimated_value_cents DESC NULLS LAST
            LIMIT 100`,
          [orgId]
        );
        pipeline = attr.rows.map((row) => ({
          opportunityId: row.opportunity_work_item_id,
          crmDealId: row.crm_deal_id,
          stage: row.stage,
          estimatedValueCents: Number(row.estimated_value_cents || 0),
          currency: row.currency,
        }));
      } catch (err: unknown) {
        if (!isMissingTable(err, 'growth_pipeline_attribution')) throw err;
        pipelineReady = false;
      }

      try {
        const hours = await client.query(
          `SELECT employee_role,
                  COALESCE(SUM(amount_numeric), 0) AS hours_saved
             FROM employee_roi_metrics
            WHERE org_id = $1 AND metric_type = 'hours_saved'
            GROUP BY employee_role
            ORDER BY hours_saved DESC`,
          [orgId]
        );
        hoursByRole = hours.rows.map((row) => ({
          employeeRole: row.employee_role,
          hoursSaved: Number(row.hours_saved || 0),
        }));
      } catch (err: unknown) {
        if (!isMissingTable(err, 'employee_roi_metrics')) throw err;
        hoursReady = false;
      }

      const hasData = hoursByRole.length > 0 || pipeline.length > 0;
      const hoursSaved = hoursByRole.reduce((sum, row) => sum + row.hoursSaved, 0);

      return NextResponse.json({
        orgId,
        pipeline,
        hoursSaved: hasData ? hoursSaved : null,
        hoursByRole,
        hasData,
        tablesReady: pipelineReady || hoursReady,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    if (isMissingTable(error)) {
      return NextResponse.json({
        pipeline: [],
        hoursSaved: null,
        hoursByRole: [],
        hasData: false,
        tablesReady: false,
      });
    }
    console.error('GET /api/analytics/roi Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
