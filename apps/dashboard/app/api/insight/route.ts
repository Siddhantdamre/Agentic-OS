import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
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
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

/**
 * GET /api/insight — semantic metric cards (A3). Numbers are YAML SQL.
 * POST /api/insight — Review Action starts InsightActionWorkflow (named).
 * Org id comes from the session. Body org_id is rejected.
 */
export async function GET() {
  try {
    const { client, orgId, userId } = await getScopedClient();
    let orgName = 'Your Business';
    let cards;
    let confirmReject = null;
    let from = '';
    let to = '';
    let gaps: string[] = [];
    let recentActions: Array<{
      id: string;
      metricId: string;
      workflowId: string;
      namedWorkflow: string | null;
      status: string;
      createdAt: string;
    }> = [];

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
      try {
        const runs = await client.query<{
          id: string;
          metric_id: string;
          workflow_id: string;
          named_workflow: string | null;
          status: string;
          created_at: Date | string;
        }>(
          `SELECT id, metric_id, workflow_id, named_workflow, status, created_at
             FROM insight_action_runs
            WHERE org_id = $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [orgId]
        );
        recentActions = runs.rows.map((row) => ({
          id: row.id,
          metricId: row.metric_id,
          workflowId: row.workflow_id,
          namedWorkflow: row.named_workflow,
          status: row.status,
          createdAt:
            row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        }));
      } catch (err: unknown) {
        const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
        if (code !== '42P01') throw err;
      }
      void userId;
    } finally {
      client.release();
    }

    let weeklyCost: {
      weeklyCostUsd: number;
      source: 'langfuse';
      verified: true;
      truncated: boolean;
      traceCount: number;
    } | null = null;
    try {
      const cost = await fetchOrgWeeklyCost(orgId);
      weeklyCost = {
        weeklyCostUsd: cost.weeklyCostUsd,
        source: cost.source,
        verified: cost.verified,
        truncated: Boolean(cost.truncated),
        traceCount: cost.traceCount,
      };
    } catch (err: unknown) {
      if (!(err instanceof LangfuseUnavailableError)) {
        console.warn('[insight] cost attach skipped:', err instanceof Error ? err.message : err);
      }
    }

    // Tripwire snapshot: metrics already marked gap/stale in cards (no fabricated alerts).
    const breached = (cards || [])
      .filter((c: { status: string }) => c.status === 'stale' || c.status === 'gap')
      .map((c: { metricId: string; title: string; status: string }) => ({
        metricId: c.metricId,
        title: c.title,
        status: c.status,
      }));

    return NextResponse.json({
      insights: cards,
      orgName,
      from,
      to,
      gaps,
      confirmReject,
      weeklyCost,
      recentActions,
      tripwires: breached,
      source: 'metrics.query',
    });
  } catch (error: unknown) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/insight Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }
    const metricId = typeof body.metricId === 'string' ? body.metricId.trim() : '';
    if (!metricId) {
      return NextResponse.json({ error: 'metricId is required' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    let namedWorkflow: ReturnType<typeof recommendedWorkflowForMetric> = null;
    try {
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

    // Record after Temporal start; release before LLM already done. Open new scoped client.
    const scoped = await getScopedClient();
    try {
      await scoped.client.query(
        `INSERT INTO insight_action_runs
           (org_id, metric_id, workflow_id, named_workflow, triggered_by_user_id, status)
         VALUES ($1, $2, $3, $4, $5, 'running')`,
        [orgId, metricId, handle.workflowId, namedWorkflow, userId]
      );
    } catch (err: unknown) {
      const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
      if (code !== '42P01') {
        console.warn('[insight] action_runs insert skipped:', err instanceof Error ? err.message : err);
      }
    } finally {
      scoped.client.release();
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
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('API POST /api/insight Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
