import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import { recordAuditEvent } from '@/lib/audit-events';
import { denyAskAiIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';
import { canApproveActions, canApproveRefunds, canCallPayTools, isPayTool, loadHumanRole } from '@/lib/rbac';
import { realtimeHub } from '@/lib/realtime-hub';
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
    const { orgId, userId } = scoped;

    const url = new URL(request.url);
    const planId = url.searchParams.get('planId');
    if (!planId) {
      // Scope to the authenticated user so coworkers cannot read each other's drafts.
      // ?history=1 drops the active-status filter so finished plans stay reviewable.
      const history = url.searchParams.get('history') === '1';
      const rows = (await client.query(
        `SELECT * FROM agent_plans
          WHERE org_id = $1
            AND user_id = $2
            AND ($3::boolean OR status IN ('pending','approved','running'))
          ORDER BY created_at DESC
          LIMIT $4`,
        [orgId, userId, history, history ? 50 : 5]
      )).rows;
      return NextResponse.json({ plans: rows });
    }

    const rows = (await client.query(
      `SELECT * FROM agent_plans
        WHERE id = $1 AND org_id = $2
          AND (user_id = $3 OR user_id IS NULL)`,
      [planId, orgId, userId]
    )).rows;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    return NextResponse.json({ plan: rows[0] });
  } catch (error: any) {
    const __scopedAuth = scopedAuthErrorResponse(error);
    if (__scopedAuth) return __scopedAuth;
    console.error('GET /api/ask-ai/plan Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}

/** Plan cancel / step edit audit (ASK-E01). A failed insert is logged, not hidden. */
async function auditPlanChange(
  client: PoolClient,
  orgId: string,
  userId: string,
  kind: 'plan.cancel' | 'plan.step_edit',
  planId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await recordAuditEvent(
      { orgId, kind, actor: { actorType: 'user', userId }, resultStatus: 'ok', planId, payload: { planId, ...payload } },
      { client, orgId }
    );
  } catch (auditErr: unknown) {
    const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
    console.warn(`[ask-ai/plan] ${kind} audit_events insert failed:`, message);
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

    const body = await tryReadJson<Record<string, unknown>>(request);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { planId: rawPlanId, action, steps } = body as { planId?: unknown; action?: unknown; steps?: unknown };
    if (typeof rawPlanId !== 'string' || !rawPlanId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 });
    }
    const planId: string = rawPlanId;
    if (body?.org_id !== undefined || body?.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const existing = (await client.query(
      `SELECT * FROM agent_plans
        WHERE id = $1 AND org_id = $2
          AND (user_id = $3 OR user_id IS NULL)`,
      [planId, orgId, userId]
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

      // SEC-R01: Verify human approver has permissions for action classes and pay tools
      const role = await loadHumanRole(client, userId);
      if (!canApproveActions(role)) {
        return NextResponse.json(
          { error: `Forbidden: role "${role}" is not authorized to approve plans` },
          { status: 403 }
        );
      }

      const planSteps = Array.isArray(existing.steps) ? existing.steps : [];
      const hasPayStep = planSteps.some((s: any) => {
        if (!s || s.enabled === false) return false;
        const tool = String(s.tool || '');
        const act = typeof s.action === 'string' ? s.action : undefined;
        return isPayTool(tool, act);
      });
      if (hasPayStep && !canCallPayTools(role)) {
        return NextResponse.json(
          { error: `Forbidden: role "${role}" is not authorized to approve plans containing payment or financial actions` },
          { status: 403 }
        );
      }

      const hasRefundStep = planSteps.some((s: any) => {
        if (!s || s.enabled === false) return false;
        const combined = `${s.tool || ''} ${s.action || ''}`;
        return /refund/i.test(combined);
      });
      if (hasRefundStep && !canApproveRefunds(role)) {
        return NextResponse.json(
          { error: `Forbidden: role "${role}" is not authorized to approve plans containing refund actions` },
          { status: 403 }
        );
      }

      await client.query(
        `UPDATE agent_plans SET status = 'approved', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId]
      );
      realtimeHub.publish(orgId, { type: 'plan_updated', message: planId });
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
      try {
        await signalPlanDecision({
          orgId,
          planId,
          decision: 'approved',
          workItemWorkflowIds,
        });
      } catch (signalErr: unknown) {
        // Signal failed but DB already says approved — revert so the UI
        // doesn't show approved while Temporal never wakes. Client already
        // released, so use a fresh scoped client for the revert.
        try {
          const revert = await getScopedClient();
          try {
            await revert.client.query(
              `UPDATE agent_plans SET status = 'pending', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
              [planId, orgId]
            );
          } finally {
            revert.client.release();
          }
        } catch { /* best-effort revert */ }
        throw signalErr;
      }
      return NextResponse.json({ success: true, status: 'approved' });
    }

    if (action === 'cancel') {
      await client.query(
        `UPDATE agent_plans SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId]
      );
      await auditPlanChange(client, orgId, userId, 'plan.cancel', planId, { previousStatus: existing.status });
      realtimeHub.publish(orgId, { type: 'plan_updated', message: planId });
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
      try {
        await signalPlanDecision({
          orgId,
          planId,
          decision: 'rejected',
          workItemWorkflowIds,
        });
      } catch (signalErr: unknown) {
        try {
          const revert = await getScopedClient();
          try {
            await revert.client.query(
              `UPDATE agent_plans SET status = 'pending', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
              [planId, orgId]
            );
          } finally {
            revert.client.release();
          }
        } catch { /* best-effort revert */ }
        throw signalErr;
      }
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
        payload?: Record<string, unknown>;
      }>;
      const byKey = (s: { id?: string; description?: string }) =>
        String(s?.id || s?.description || '');
      const incomingByKey = new Map(incoming.map((s) => [byKey(s), s]));
      const merged = parsedSteps.map((step: any) => {
        const patch = incomingByKey.get(byKey(step)) || incomingByKey.get(String(step.description || ''));
        if (!patch) return step;
        const next = { ...step, enabled: patch.enabled !== false };
        if (patch.payload && typeof patch.payload === 'object') {
          next.payload = patch.payload;
        }
        if (typeof patch.description === 'string' && patch.description.trim()) {
          next.description = patch.description.trim().slice(0, 200);
        }
        return next;
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
      // Step ids, tools and on/off only: edited arguments can hold customer data.
      await auditPlanChange(client, orgId, userId, 'plan.step_edit', planId, {
        steps: capped.map((step: any) => ({
          id: step.id ?? null,
          tool: step.tool ?? null,
          action: step.action ?? null,
          enabled: step.enabled !== false,
        })),
        payloadEdited: incoming.filter((st) => st.payload && typeof st.payload === 'object').map((st) => byKey(st)),
      });
      realtimeHub.publish(orgId, { type: 'plan_updated', message: planId });
      return NextResponse.json({ success: true, steps: capped });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error: any) {
    if (isRateLimitError(error)) {
      return responseFromRateLimit(error);
    }
    const __scopedAuth2 = scopedAuthErrorResponse(error);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('PATCH /api/ask-ai/plan Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}