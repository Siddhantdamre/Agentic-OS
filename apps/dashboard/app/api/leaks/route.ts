import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { summariseRevival } from '@darex/workflows/dist/leads/quiet.js';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/leaks — where money is walking out that nobody can see.
 * POST /api/leaks — arm, watch, or switch off the follow-up agent.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * A business knows about the deal it lost. Somebody said no, and that is a
 * fact with a shape. What it does not know about is:
 *
 *   the lead who enquired, got an answer, and was never contacted again
 *   the question it could not answer, after which the customer simply left
 *   the promise made in a conversation that nobody wrote down
 *   the thread escalated to a human that no human has picked up
 *
 * None of those leave a mark anywhere. They are not in the CRM, because
 * nothing happened. They are the largest losses in a small business and the
 * only ones with no record at all.
 *
 * Darex has the record, because it was the one in the conversation. A WhatsApp
 * platform has the messages but no judgement about them — it cannot tell that
 * a question went unanswered. A CRM has the deals but not what was said. That
 * asymmetry is the whole reason this endpoint can exist.
 *
 * ── WHAT IT REFUSES TO DO ─────────────────────────────────────────────────
 *
 * It never puts a rupee figure on a leak. "You are losing ₹4.2L a month" would
 * be the most persuasive sentence on the page and it would be invented: a
 * quiet lead is not a lost sale, it is a lead nobody followed up. Counting it
 * as revenue would make this a slide rather than an instrument, and the first
 * owner who checked would never trust another number here.
 *
 * So every leak is a COUNT of a thing that actually happened, with the rows
 * behind it available. The reader does the arithmetic about what it is worth,
 * because only they know their conversion rate.
 */

interface Leak {
  key: 'quiet_leads' | 'unanswered' | 'unkept_promises' | 'waiting_on_a_human';
  count: number;
  /** What happened, in the owner's words. Never a metric name. */
  headline: string;
  /** Why it costs money, in one sentence. */
  why: string;
  /** What to do, or null when the agent is already handling it. */
  action: string | null;
}

export async function GET() {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    const automation = await client.query(
      `SELECT mode, enabled_at FROM org_automation
        WHERE org_id = $1 AND trigger_key = 'lead.quiet'`,
      [orgId],
    );
    const mode: string = automation.rows[0]?.mode ?? 'off';

    // ── The follow-up agent's own ledger ────────────────────────────────────
    const followups = await client.query(
      `SELECT id, conversation_id, nudge_number, quiet_days, status, skip_reason,
              draft, sent_at, replied_at, created_at
         FROM lead_followups
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [orgId],
    );

    const rows = followups.rows;
    const outcomes = rows.map((r) =>
      r.status !== 'sent' ? 'not_sent' : (r.replied_at ? 'replied' : 'no_reply'),
    ) as Array<'no_reply' | 'replied' | 'not_sent'>;

    // The arithmetic is the same tested module the runner uses. Two copies of
    // a trust metric drift, and only one of them has tests.
    const revival = summariseRevival(outcomes);

    const proposed = rows.filter((r) => r.status === 'proposed');
    const suppressed = rows.filter((r) => r.status === 'suppressed');
    const sent = rows.filter((r) => r.status === 'sent');

    // THE REFUSALS ARE THE POINT.
    //
    // An owner's first question is never "who did you contact". It is "did you
    // message the man who was complaining about his refund?". Being able to
    // answer "no — here is the row, and here is why" is what makes this safe
    // to leave switched on. A panel that showed only the sends could not
    // answer the only question that matters.
    const refused = rows
      .filter((r) => r.status === 'skipped')
      .map((r) => ({
        reason: String(r.skip_reason || 'unknown'),
        quietDays: Number(r.quiet_days) || 0,
      }));

    const refusedByReason: Record<string, number> = {};
    for (const r of refused) refusedByReason[r.reason] = (refusedByReason[r.reason] || 0) + 1;

    // ── The leaks nobody is currently shown ─────────────────────────────────
    const [gaps, promises, waiting] = await Promise.all([
      // `open` only, NOT `<> 'resolved'`.
      //
      // knowledge_gaps has three states: open, resolved, dismissed. `dismissed`
      // is the owner having looked at a question and decided it does not
      // matter. Counting it as a leak inflates the number in the flattering
      // direction -- it makes this product look more valuable than it is --
      // and the first owner who clicks through, finds something they
      // personally dismissed, and sees it billed as a loss stops believing
      // every other number on the page.
      client.query(
        `SELECT COUNT(*)::int AS n FROM knowledge_gaps
          WHERE org_id = $1 AND status = 'open'`, [orgId]),
      // Same reasoning: commitments are open | kept | broken | cancelled.
      // A cancelled promise was deliberately withdrawn and is not a leak. An
      // open one is still owed and a broken one was missed; both are.
      client.query(
        `SELECT COUNT(*)::int AS n FROM commitments
          WHERE org_id = $1 AND status IN ('open', 'broken')`, [orgId]),
      client.query(
        `SELECT COUNT(*)::int AS n FROM conversations
          WHERE org_id = $1 AND status = 'needs_attention'`, [orgId]),
    ]);

    const leaks: Leak[] = [
      {
        key: 'quiet_leads',
        count: proposed.length + suppressed.length,
        headline: 'People who enquired and were never contacted again',
        why: 'They asked, you answered, and the conversation stopped. Nobody followed up because it is nobody’s job.',
        action: mode === 'on' ? null : 'Let the agent follow them up',
      },
      {
        key: 'unanswered',
        count: Number(gaps.rows[0]?.n) || 0,
        headline: 'Questions nobody could answer',
        why: 'The customer asked something the agent had no source for. They did not complain — they left.',
        action: 'Answer them once and the agent knows forever',
      },
      {
        key: 'unkept_promises',
        count: Number(promises.rows[0]?.n) || 0,
        headline: 'Promises made and not yet kept',
        why: 'Somebody was told they would hear back. Nothing was written down anywhere until now.',
        action: 'Close them out',
      },
      {
        key: 'waiting_on_a_human',
        count: Number(waiting.rows[0]?.n) || 0,
        headline: 'Threads waiting on a person',
        why: 'The agent stopped and asked for help. Until somebody looks, the customer is waiting.',
        action: 'Open the queue',
      },
    ];

    return NextResponse.json({
      mode,
      enabledAt: automation.rows[0]?.enabled_at ?? null,
      leaks,
      followUps: {
        // What it wants to send, awaiting a person.
        proposed: proposed.slice(0, 20).map((r) => ({
          id: r.id,
          conversationId: r.conversation_id,
          quietDays: Number(r.quiet_days) || 0,
          nudgeNumber: Number(r.nudge_number) || 1,
          draft: String(r.draft || ''),
        })),
        // Drafted while watching, deliberately never sent.
        suppressedCount: suppressed.length,
        sentCount: sent.length,
        refusedByReason,
        revival,
      },
    });
  } catch (err) {
    // A leak report that 500s tells an owner nothing about their business and
    // everything about ours. Say which part failed.
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: `could not read the leak report: ${message}` }, { status: 500 });
  } finally {
    client.release();
  }
}

/**
 * POST /api/leaks — off | dry_run | on
 *
 * Three states on purpose, not a toggle. `dry_run` is the one that makes this
 * safe to adopt: the agent drafts every follow-up and sends none, so a
 * business can read a fortnight of what it WOULD have said before letting it
 * say anything. A two-state switch forces a decision nobody has the evidence
 * to make yet.
 */
export async function POST(request: Request) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    const body = await request.json().catch(() => ({}));
    const mode = String((body as { mode?: unknown }).mode ?? '');
    if (!['off', 'dry_run', 'on'].includes(mode)) {
      return NextResponse.json(
        { error: 'mode must be off, dry_run or on' },
        { status: 400 },
      );
    }

    await client.query(
      `INSERT INTO org_automation (org_id, trigger_key, mode, enabled_at)
       VALUES ($1, 'lead.quiet', $2, CASE WHEN $2 = 'off' THEN NULL ELSE NOW() END)
       ON CONFLICT (org_id, trigger_key) DO UPDATE
         SET mode = EXCLUDED.mode,
             enabled_at = CASE WHEN EXCLUDED.mode = 'off' THEN NULL
                               ELSE COALESCE(org_automation.enabled_at, NOW()) END,
             updated_at = NOW()`,
      [orgId, mode],
    );

    // The message is what an owner reads at the moment they change a setting
    // that can message their customers. It says exactly what will now happen.
    const message =
      mode === 'on'
        ? 'The agent will follow up quiet leads. It never contacts anyone who said no, complained, or is waiting on your reply, and never more than twice.'
        : mode === 'dry_run'
          ? 'Watching. The agent will draft every follow-up and send none, so you can read what it would have said.'
          : 'Off. No follow-ups will be drafted or sent.';

    return NextResponse.json({ mode, message });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    client.release();
  }
}
