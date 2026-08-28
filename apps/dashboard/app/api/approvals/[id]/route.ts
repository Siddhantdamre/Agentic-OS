import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { signalWorkItemDecision } from '@darex/workflows/dist/workflow-client.js';

export const dynamic = 'force-dynamic';

/**
 * POST /api/approvals/{id} — a person answers.
 *
 * Body: { decision: 'approved' | 'rejected', reason?: string }
 *
 * ORDER MATTERS, AND NOT FOR THE USUAL REASON.
 * The decision is written to the database FIRST and signalled to Temporal
 * second. WorkItemWorkflow waits two minutes for that signal and humans do not
 * answer in two minutes — the 24 requests that were stuck when this shipped
 * had timed out thirteen days earlier. So a signal is a best-effort bonus, and
 * the durable record is the actual product: it is what updates the trust
 * ledger, what an audit reads, and what lets the work be re-driven.
 *
 * Signalling first and recording second would mean a crash between the two
 * loses the human's decision while the agent acts on it, which is the worst
 * available ordering.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId, userId } = scoped;

  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

    if (decision !== 'approved' && decision !== 'rejected') {
      return NextResponse.json(
        { error: 'decision must be approved or rejected.' },
        { status: 400 },
      );
    }
    // A rejection without a reason teaches nothing. This is the highest-value
    // text the product collects — it says what the agent got wrong in a case a
    // human cared enough to stop — so it is required rather than optional.
    if (decision === 'rejected' && reason.length < 3) {
      return NextResponse.json(
        { error: 'Say briefly why, so the agent can be corrected.' },
        { status: 400 },
      );
    }

    const wf = await client.query(
      `SELECT temporal_workflow_id FROM approval_requests
        WHERE id = $1 AND org_id = $2 AND status = 'pending' LIMIT 1`,
      [id, orgId],
    );
    if (!wf.rows.length) {
      return NextResponse.json(
        { error: 'That approval is not pending — it may already have been answered.' },
        { status: 409 },
      );
    }

    const decided = await client.query(
      `SELECT * FROM decide_approval($1::uuid, $2::uuid, $3::text, $4::uuid, $5::text)`,
      [orgId, id, decision, userId, reason || null],
    );
    const row = decided.rows[0] || {};

    // Best effort, after the record is safe.
    let signalled: { signalled: boolean; reason?: string } = { signalled: false };
    const workflowId = wf.rows[0].temporal_workflow_id;
    if (workflowId) {
      try {
        signalled = await signalWorkItemDecision({ workflowId, decision });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[approvals] signal failed after recording decision:', message);
      }
    }

    return NextResponse.json({
      status: decision,
      actionClass: row.out_action_class,
      autonomyLevel: row.out_new_level,
      // Told plainly when a decision has just changed how the agent behaves.
      // A promotion nobody is informed about is a surprise waiting to happen.
      promoted: Boolean(row.out_promoted),
      signalled: signalled.signalled,
      signalNote: signalled.signalled ? undefined : signalled.reason,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no pending approval/.test(message)) {
      return NextResponse.json({ error: 'That approval is no longer pending.' }, { status: 409 });
    }
    console.error('[approvals/:id]', message);
    return NextResponse.json({ error: 'Could not record that decision.' }, { status: 500 });
  } finally {
    client.release();
  }
}
