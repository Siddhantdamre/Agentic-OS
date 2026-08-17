import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import {
  buildInsightCards,
  isInsightNamedWorkflow,
  queryRegisteredMetrics,
  recommendedWorkflowForMetric,
} from '@/lib/insight-engine';
import {
  fetchOrgWeeklyCost,
  LangfuseUnavailableError,
  queryConfirmRejectDrift,
} from '@/lib/org-cost';
import { startInsightActionWorkflow } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/insight — semantic metric cards (A3). Numbers are YAML SQL.
 * POST /api/insight — Review Action starts InsightActionWorkflow (named).
 * Org id comes from the session. Body org_id is rejected.
 */
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    let orgName = 'Your Business';
    let cards;
    let confirmReject = null;
    let from = '';
    let to = '';
    let gaps: string[] = [];

    try {
      const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
      orgName = orgRes.rows[0]?.name || 'Your Business';
      const queried = await queryRegisteredMetrics(client, orgId);
      from = queried.from;
      to = queried.to;
      gaps = queried.gaps;
      cards = buildInsightCards(queried);
      const windowStart = new Date(queried.from);
      confirmReject = await queryConfirmRejectDrift(client, orgId, windowStart);
    } finally {
      client.release();
    }

    let weeklyCost: { weeklyCostUsd: number; source: 'langfuse'; verified: true } | null = null;
    try {
      const cost = await fetchOrgWeeklyCost(orgId);
      weeklyCost = {
        weeklyCostUsd: cost.weeklyCostUsd,
        source: cost.source,
        verified: cost.verified,
      };
    } catch (err: unknown) {
      if (!(err instanceof LangfuseUnavailableError)) {
        console.warn('[insight] cost attach skipped:', err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json({
      insights: cards,
      orgName,
      from,
      to,
      gaps,
      confirmReject,
      weeklyCost,
      source: 'metrics.query',
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API /api/insight Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    let metricId = '';
    let namedWorkflow: ReturnType<typeof recommendedWorkflowForMetric> = null;

    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.org_id !== undefined || body.orgId !== undefined) {
        return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
      }
      metricId = typeof body.metricId === 'string' ? body.metricId.trim() : '';
      if (!metricId) {
        return NextResponse.json({ error: 'metricId is required' }, { status: 400 });
      }
      const requested =
        typeof body.namedWorkflow === 'string' ? body.namedWorkflow.trim() : recommendedWorkflowForMetric(metricId);
      namedWorkflow = requested && isInsightNamedWorkflow(requested) ? requested : recommendedWorkflowForMetric(metricId);
      if (!namedWorkflow) {
        return NextResponse.json(
          { error: 'This metric has no named workflow. Review Action is not available.' },
          { status: 400 }
        );
      }
    } finally {
      client.release();
    }

    const handle = await startInsightActionWorkflow({
      orgId,
      metricId,
      namedWorkflow,
    });
    if (!handle) {
      return NextResponse.json(
        { error: 'Temporal is unavailable — InsightActionWorkflow was not started' },
        { status: 503 }
      );
    }

    return NextResponse.json({
      ok: true,
      workflowId: handle.workflowId,
      workflowName: 'InsightActionWorkflow',
      namedWorkflow,
      metricId,
      orgId,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API POST /api/insight Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
