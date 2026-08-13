import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { recordAuditEvent } from '@/lib/inbound-confirm';
import { denyAskAiIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';
import { signalPlanDecision } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

/**
 * GET/PATCH /api/ask-ai/plan
 * - GET ?planId=...  -> fetch a persisted plan (restores after refresh)
 * - PATCH { planId, action: 'approve' | 'cancel', steps?: [{id,enabled}] }
 */
export async function GET(request: Request) {
  let client: any = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId } = scoped;

    const url = new URL(request.url);
    const planId = url.searchParams.get('planId');
    if (!planId) {
      const rows = (await client.query(
        `SELECT * FROM agent_plans WHERE org_id = $1 AND status IN ('pending','approved','running') ORDER BY created_at DESC LIMIT 3`,
        [orgId]
      )).rows;
      return NextResponse.json({ plans: rows });
    }

    const rows = (await client.query(
      `SELECT * FROM agent_plans WHERE id = $1 AND org_id = $2`,
      [planId, orgId]
    )).rows;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    return NextResponse.json({ plan: rows[0] });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('GET /api/ask-ai/plan Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}

export async function PATCH(request: Request) {
  let client: any = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    const limited = denyAskAiIfLimited(orgId);
    if (limited) {
      return limited;
    }

    const body = await request.json();
    const { planId, action, steps } = body || {};
    if (!planId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 });
    }
    if (body?.org_id !== undefined || body?.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const existing = (await client.query(
      `SELECT * FROM agent_plans WHERE id = $1 AND org_id = $2`,
      [planId, orgId]
    )).rows[0];
    if (!existing) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return NextResponse.json({ error: `Plan already ${existing.status}` }, { status: 409 });
    }

    if (action === 'approve') {
      if (existing.status !== 'pending') {
        return NextResponse.json(
          { error: `Plan must be pending to approve (status: ${existing.status})` },
          { status: 409 }
        );
      }
      await client.query(
        `UPDATE agent_plans SET status = 'approved', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId]
      );
      // HOOK(ws-22/S3): audit_events — persist who approved.
      try {
        await recordAuditEvent(
          {
            orgId,
            kind: 'plan.approve',
            actor: { actorType: 'user', userId },
            resultStatus: 'ok',
            planId,
            approverUserId: userId,
            payload: { planId, approverUserId: userId },
          },
          { client, orgId }
        );
      } catch (auditErr: unknown) {
        const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
        console.warn('[ask-ai/plan] audit_events insert failed:', message);
      }
      const waiting = await client.query(
        `SELECT temporal_workflow_id FROM work_items
         WHERE org_id = $1
           AND temporal_workflow_id IS NOT NULL
           AND metadata->>'planId' = $2
         LIMIT 8`,
        [orgId, planId]
      );
      const workItemWorkflowIds = waiting.rows
        .map((r: { temporal_workflow_id?: string }) => r.temporal_workflow_id)
        .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
      client.release();
      client = null;
      await signalPlanDecision({
        orgId,
        planId,
        decision: 'approved',
        workItemWorkflowIds,
      });
      return NextResponse.json({ success: true, status: 'approved' });
    }

    if (action === 'cancel') {
      await client.query(
        `UPDATE agent_plans SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId]
      );
      const waiting = await client.query(
        `SELECT temporal_workflow_id FROM work_items
         WHERE org_id = $1 AND temporal_workflow_id IS NOT NULL AND metadata->>'planId' = $2
         LIMIT 8`,
        [orgId, planId]
      );
      const workItemWorkflowIds = waiting.rows
        .map((r: { temporal_workflow_id?: string }) => r.temporal_workflow_id)
        .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
      client.release();
      client = null;
      await signalPlanDecision({
        orgId,
        planId,
        decision: 'rejected',
        workItemWorkflowIds,
      });
      return NextResponse.json({ success: true, status: 'cancelled' });
    }

    // Partial: update per-step enabled flags and append user instructions while pending
    if (steps && Array.isArray(steps) && existing.status === 'pending') {
      const parsedSteps = Array.isArray(existing.steps) ? existing.steps : [];
      const incoming = steps as Array<{
        id?: string;
        description?: string;
        tool?: string;
        action?: string;
        enabled?: boolean;
      }>;
      const byKey = (s: { id?: string; description?: string }) =>
        String(s?.id || s?.description || '');
      const incomingByKey = new Map(incoming.map((s) => [byKey(s), s]));
      const merged = parsedSteps.map((step: any) => {
        const patch = incomingByKey.get(byKey(step)) || incomingByKey.get(String(step.description || ''));
        if (!patch) return step;
        return { ...step, enabled: patch.enabled !== false };
      });
      for (const s of incoming) {
        const key = byKey(s);
        if (!key) continue;
        const exists = merged.some(
          (step: any) => byKey(step) === key || String(step.description || '') === String(s.description || '')
        );
        if (exists) continue;
        merged.push({
          id: s.id || `step-${merged.length + 1}`,
          description: String(s.description).slice(0, 200),
          tool: 'user_instruction',
          action: 'note',
          payload: {},
          enabled: s.enabled !== false,
        });
      }
      const capped = merged.slice(0, 12);
      await client.query(
        `UPDATE agent_plans SET steps = $3, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId, JSON.stringify(capped)]
      );
      return NextResponse.json({ success: true, steps: capped });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error: any) {
    if (isRateLimitError(error)) {
      return responseFromRateLimit(error);
    }
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('PATCH /api/ask-ai/plan Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}