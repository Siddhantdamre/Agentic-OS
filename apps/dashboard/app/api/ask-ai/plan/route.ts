import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

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
    const { orgId } = scoped;

    const body = await request.json();
    const { planId, action, steps } = body || {};
    if (!planId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 });
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
      await client.query(
        `UPDATE agent_plans SET status = 'approved', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId]
      );
      return NextResponse.json({ success: true, status: 'approved' });
    }

    if (action === 'cancel') {
      await client.query(
        `UPDATE agent_plans SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId]
      );
      return NextResponse.json({ success: true, status: 'cancelled' });
    }

    // Partial: update per-step enabled flags while pending
    if (steps && Array.isArray(steps) && existing.status === 'pending') {
      const parsedSteps = existing.steps || [];
      const enabledByDescription = new Map(
        steps.map((s: any) => [String(s?.description || s?.id || ''), s?.enabled !== false])
      );
      const merged = parsedSteps.map((step: any) => ({
        ...step,
        enabled: enabledByDescription.get(String(step.description || step.id || '')) ?? step.enabled !== false,
      }));
      await client.query(
        `UPDATE agent_plans SET steps = $3, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
        [planId, orgId, JSON.stringify(merged)]
      );
      return NextResponse.json({ success: true, steps: merged });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('PATCH /api/ask-ai/plan Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}