import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/approvals — what the agent is waiting to be allowed to do.
 *
 * WHY THIS EXISTS
 * Measured on the live database before this shipped:
 *
 *   work_items status = 'waiting_approval'    24
 *   work_events kind  = 'confirm_requested'   24
 *   work_events kind  = 'confirm_approved'     0
 *
 * The oldest had been waiting since 15 August. WorkItemWorkflow defines the
 * approveWorkItem signal and handles it correctly, and no caller existed
 * anywhere in the dashboard — so the agent asked twenty-four times and could
 * never be answered. Every consequential action sat behind a door with no
 * handle.
 *
 * Also returns the current autonomy level per action class, because an
 * operator deciding whether to approve something should be able to see what
 * their previous approvals have already granted.
 */
export async function GET() {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    const pending = await client.query(
      `SELECT a.id, a.action_class, a.summary, a.draft, a.created_at,
              a.work_item_id, a.conversation_id,
              c.contact_id
         FROM approval_requests a
         LEFT JOIN conversations c ON c.id = a.conversation_id AND c.org_id = a.org_id
        WHERE a.org_id = $1 AND a.status = 'pending'
        ORDER BY a.created_at
        LIMIT 100`,
      [orgId],
    );

    const autonomy = await client.query(
      `SELECT action_class, level, consecutive_approvals,
              total_approvals, total_rejections,
              action_class_may_graduate(action_class) AS may_graduate,
              autonomy_promotion_threshold()          AS threshold
         FROM org_action_autonomy
        WHERE org_id = $1
        ORDER BY action_class`,
      [orgId],
    );

    return NextResponse.json({
      pending: pending.rows.map((r) => ({
        id: r.id,
        actionClass: r.action_class,
        summary: r.summary,
        draft: r.draft,
        createdAt: r.created_at,
        workItemId: r.work_item_id,
        conversationId: r.conversation_id,
        contactId: r.contact_id,
      })),
      autonomy: autonomy.rows.map((r) => ({
        actionClass: r.action_class,
        level: r.level,
        consecutiveApprovals: r.consecutive_approvals,
        totalApprovals: r.total_approvals,
        totalRejections: r.total_rejections,
        // False for pay, sign and legal — no amount of history promotes those.
        // Surfaced so the screen can say so rather than leaving an operator to
        // wonder why a class never advances.
        mayGraduate: r.may_graduate,
        threshold: r.threshold,
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[approvals]', message);
    return NextResponse.json({ error: 'Could not load approvals.' }, { status: 500 });
  } finally {
    client.release();
  }
}
