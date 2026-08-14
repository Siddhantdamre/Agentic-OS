import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import {
  loadOrgPromotedPlaybooks,
  sanitizePromotionSteps,
  slugifyPlaybookName,
} from '@/lib/insight-engine';
import { queryConfirmRejectDrift } from '@/lib/org-cost';

export const dynamic = 'force-dynamic';

type FeedbackVote = 'up' | 'down';

function isVote(value: unknown): value is FeedbackVote {
  return value === 'up' || value === 'down';
}

/**
 * Ask AI learning loop (B4 / A5).
 * - POST vote: thumbs, stored without message bodies.
 * - POST promote: human-named org playbook from a completed/approved plan.
 * Never trusts body org_id. Never trains across tenants.
 */
export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const confirmReject = await queryConfirmRejectDrift(client, orgId, from);
      const promotions = await loadOrgPromotedPlaybooks(client, orgId);
      let up = 0;
      let down = 0;
      try {
        const votes = await client.query(
          `SELECT
             COUNT(*) FILTER (WHERE vote = 'up')::int AS up,
             COUNT(*) FILTER (WHERE vote = 'down')::int AS down
           FROM ask_ai_feedback
           WHERE org_id = $1 AND created_at >= $2`,
          [orgId, from.toISOString()]
        );
        up = Number(votes.rows[0]?.up || 0);
        down = Number(votes.rows[0]?.down || 0);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!(/does not exist/i.test(message) && message.includes('ask_ai_feedback'))) throw err;
      }
      return NextResponse.json({
        orgId,
        confirmReject,
        promotions,
        votes: { up, down },
        crossOrgTraining: false,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('GET /api/ask-ai/feedback Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (body.org_id !== undefined || body.orgId !== undefined) {
        return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
      }

      const actionRaw = typeof body.action === 'string' ? body.action : 'vote';
      const action = actionRaw === 'promote' || actionRaw === 'vote' ? actionRaw : null;
      if (!action) {
        return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
      }
      switch (action) {
        case 'vote':
          return await handleVote(client, orgId, userId, body);
        case 'promote':
          return await handlePromote(client, orgId, userId, body);
        default: {
          const _exhaustive: never = action;
          return _exhaustive;
        }
      }
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('POST /api/ask-ai/feedback Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

async function handleVote(
  client: Awaited<ReturnType<typeof getScopedClient>>['client'],
  orgId: string,
  userId: string,
  body: Record<string, unknown>
) {
  if (!isVote(body.vote)) {
    return NextResponse.json({ error: 'vote must be up or down' }, { status: 400 });
  }
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;
  const planId = typeof body.planId === 'string' ? body.planId : null;
  const messageId = typeof body.messageId === 'string' ? body.messageId.slice(0, 120) : null;

  if (conversationId) {
    const owned = await client.query(`SELECT id FROM conversations WHERE id = $1 AND org_id = $2`, [
      conversationId,
      orgId,
    ]);
    if (owned.rows.length === 0) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
  }
  if (planId) {
    const owned = await client.query(`SELECT id FROM agent_plans WHERE id = $1 AND org_id = $2`, [planId, orgId]);
    if (owned.rows.length === 0) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    }
  }

  if (messageId) {
    await client.query(
      `DELETE FROM ask_ai_feedback WHERE org_id = $1 AND user_id = $2 AND message_id = $3`,
      [orgId, userId, messageId]
    );
  }
  await client.query(
    `INSERT INTO ask_ai_feedback (org_id, user_id, conversation_id, plan_id, message_id, vote)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, userId, conversationId, planId, messageId, body.vote]
  );

  return NextResponse.json({
    ok: true,
    vote: body.vote,
    trained: false,
    crossOrgTraining: false,
  });
}

async function handlePromote(
  client: Awaited<ReturnType<typeof getScopedClient>>['client'],
  orgId: string,
  userId: string,
  body: Record<string, unknown>
) {
  const planId = typeof body.planId === 'string' ? body.planId : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!planId) {
    return NextResponse.json({ error: 'planId is required' }, { status: 400 });
  }
  if (name.length < 3 || name.length > 80) {
    return NextResponse.json({ error: 'A human playbook name (3–80 characters) is required' }, { status: 400 });
  }
  const playbookId = slugifyPlaybookName(name);
  if (!playbookId.startsWith('org.')) {
    return NextResponse.json({ error: 'Playbook name did not produce a valid org.* id' }, { status: 400 });
  }

  const planRes = await client.query(
    `SELECT id, status, steps, summary FROM agent_plans WHERE id = $1 AND org_id = $2`,
    [planId, orgId]
  );
  const plan = planRes.rows[0] as
    | { id: string; status: string; steps: unknown; summary: string }
    | undefined;
  if (!plan) {
    return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
  }

  const promotable = new Set(['completed', 'approved', 'running', 'completed_with_errors']);
  const blocked = new Set(['pending', 'cancelled', 'failed']);
  if (blocked.has(plan.status)) {
    return NextResponse.json(
      { error: `Plan status ${plan.status} cannot be promoted. Confirm or complete it first.` },
      { status: 409 }
    );
  }
  if (!promotable.has(plan.status)) {
    return NextResponse.json({ error: `Plan status ${plan.status} cannot be promoted` }, { status: 409 });
  }

  const steps = sanitizePromotionSteps(plan.steps);
  if (steps.length === 0) {
    return NextResponse.json({ error: 'Plan has no promotable steps' }, { status: 400 });
  }

  const inserted = await client.query(
    `INSERT INTO org_playbook_promotions
       (org_id, playbook_id, name, plan_id, steps, summary, named_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, playbook_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       plan_id = EXCLUDED.plan_id,
       steps = EXCLUDED.steps,
       summary = EXCLUDED.summary,
       named_by_user_id = EXCLUDED.named_by_user_id,
       updated_at = NOW()
     RETURNING playbook_id, name, created_at`,
    [orgId, playbookId, name, planId, JSON.stringify(steps), String(plan.summary || name).slice(0, 240), userId]
  );

  return NextResponse.json({
    ok: true,
    promotion: {
      playbookId: inserted.rows[0].playbook_id,
      name: inserted.rows[0].name,
      namedByUserId: userId,
      createdAt: inserted.rows[0].created_at,
    },
    trained: false,
    crossOrgTraining: false,
    note: 'Replay uses the playbook matcher for this org only. No tenant PII was copied.',
  });
}
