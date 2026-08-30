import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { reviseDraft } from '@/lib/plan-generator';
import { denyAskAiIfLimited, isRateLimitError, responseFromRateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * POST /api/ask-ai/revise
 * Revise the draft of a plan based on user feedback. Loops back to the
 * planner LLM, increments the draft version, and keeps the plan in `pending`
 * (or `approved` if it was already approved) so execution can proceed after
 * the improved draft is accepted.
 */
export async function POST(request: Request) {
  let client: any = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId } = scoped;

    const limited = denyAskAiIfLimited(orgId);
    if (limited) {
      return limited;
    }

    const body = await request.json();
    const { planId, feedback } = body || {};
    if (!planId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 });
    }
    if (!feedback || !String(feedback).trim()) {
      return NextResponse.json({ error: 'feedback is required' }, { status: 400 });
    }

    const rows = (await client.query(
      `SELECT * FROM agent_plans WHERE id = $1 AND org_id = $2`,
      [planId, orgId]
    )).rows;
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
    const plan = rows[0];
    const allowedStatuses = ['pending', 'approved', 'completed', 'completed_with_errors', 'failed'];
    if (!allowedStatuses.includes(plan.status)) {
      return NextResponse.json(
        { error: `Cannot revise a plan in status "${plan.status}"` },
        { status: 409 }
      );
    }

    const previousVersion = Number(plan.draft?.version || 0);
    const currentDraft = String(plan.draft?.content || '');
    const summary = String(plan.summary || '');

    const revised = (await reviseDraft(summary || '', currentDraft, String(feedback), orgId)).trim();
    if (!revised) {
      return NextResponse.json({ error: 'Draft revision produced empty output' }, { status: 502 });
    }

    // A revised draft is new content — always route back through explicit approval,
    // never straight to 'approved' (which would make it immediately re-executable
    // without a human looking at the revision first).
    const newStatus = ['completed', 'completed_with_errors', 'failed'].includes(plan.status) ? 'pending' : plan.status;

    await client.query(
      `UPDATE agent_plans SET draft = $3, feedback = $4, status = $5, updated_at = NOW() WHERE id = $1 AND org_id = $2`,
      [planId, orgId, JSON.stringify({ content: revised, version: previousVersion + 1 }), String(feedback), newStatus]
    );

    return NextResponse.json({
      success: true,
      draft: { content: revised, version: previousVersion + 1 },
      status: newStatus,
    });
  } catch (error: any) {
    if (isRateLimitError(error)) {
      return responseFromRateLimit(error);
    }
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/ask-ai/revise Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    if (client) client.release();
  }
}