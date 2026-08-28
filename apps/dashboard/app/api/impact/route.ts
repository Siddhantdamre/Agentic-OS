import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
// The arithmetic lives in one place, with its own 15 unit tests. The API
// shapes the query; it does not re-implement the sums, because two copies of
// a revenue calculation drift and only one of them is tested.
import { summariseMoney, autonomousValuePct } from '@darex/workflows/dist/outcomes/money.js';

export const dynamic = 'force-dynamic';

/**
 * GET /api/impact?days=30 — what the AI actually did, and whether it is improving.
 *
 * WHY THIS EXISTS
 * The outcome ledger (migrations 022/023, outcome-ledger.ts, 18 passing unit
 * tests) had zero importers. Nothing ran it and nothing read it. So the only
 * question a customer asks at renewal — what did this do for us? — could only
 * be answered with a feeling.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * Not a vanity dashboard. "Your AI sent 240 replies" is a number about
 * activity, and a business can already see that its inbox is busy. The number
 * that decides a renewal is how much work stopped needing a person, and
 * whether that is going the right way.
 *
 * So the headline is autonomous resolution: conversations the agent finished
 * with no human message in them at all. The counterpart — takeovers, where a
 * person had to step in after the agent replied — is reported beside it and is
 * never netted out. A measurement that can only move one way is not a
 * measurement.
 *
 * HONESTY ABOUT CAUSATION
 * `teaching` and `trend` are reported side by side, never multiplied together
 * into a claim. Without a holdout arm there is no control group, so the most
 * this data supports is "these moved together". outcome-ledger.ts is explicit
 * that callers must present correlation as correlation, and `causal` in the
 * response says plainly whether a control exists. It normally does not.
 */
export async function GET(request: Request) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(365, Math.max(1, Number(searchParams.get('days')) || 30));

    /**
     * One period's numbers. Called twice — this period and the one before —
     * because a rate without a direction tells a business nothing about
     * whether to renew.
     */
    const periodStats = async (fromDaysAgo: number, toDaysAgo: number) => {
      const res = await client.query(
        `WITH scoped AS (
           SELECT c.id,
                  c.resolved_at,
                  c.metadata #>> '{resolution,kind}' AS resolution_kind
             FROM conversations c
            WHERE c.org_id = $1
              AND c.started_at >= NOW() - ($2 || ' days')::interval
              AND c.started_at <  NOW() - ($3 || ' days')::interval
              -- Only conversations the agent actually took part in. A thread a
              -- human handled start to finish is not evidence about the AI in
              -- either direction, and counting it would drag the rate toward
              -- whatever the humans happened to be doing that month.
              AND EXISTS (
                SELECT 1 FROM messages m
                 WHERE m.conversation_id = c.id AND m.org_id = c.org_id
                   AND m.role = 'assistant'
              )
         )
         SELECT
           COUNT(*)::int                                                        AS handled,
           COUNT(*) FILTER (WHERE resolution_kind = 'autonomous')::int          AS autonomous,
           COUNT(*) FILTER (WHERE resolution_kind = 'with_human')::int          AS with_human,
           COUNT(*) FILTER (WHERE resolved_at IS NULL)::int                     AS still_open
         FROM scoped`,
        [orgId, String(fromDaysAgo), String(toDaysAgo)],
      );
      const r = res.rows[0];
      // The denominator is CLOSED conversations only. Dividing by everything
      // including still-open threads would make the rate fall every time
      // traffic rose, which reads as the agent getting worse during exactly
      // the weeks it is doing the most work.
      const closed = r.autonomous + r.with_human;
      return {
        handled: r.handled,
        autonomous: r.autonomous,
        withHuman: r.with_human,
        stillOpen: r.still_open,
        closed,
        autonomousPct: closed > 0 ? Math.round((r.autonomous / closed) * 1000) / 10 : null,
      };
    };

    const [current, previous] = await Promise.all([
      periodStats(days, 0),
      periodStats(days * 2, days),
    ]);

    // What the team taught it in the same period. These are the inputs a
    // business controls; the resolution rate is the output.
    const taught = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM reply_edits
           WHERE org_id = $1 AND learned = true
             AND created_at >= NOW() - ($2 || ' days')::interval)          AS corrections,
         (SELECT COUNT(*)::int FROM knowledge_gaps
           WHERE org_id = $1 AND status = 'resolved'
             AND resolved_at >= NOW() - ($2 || ' days')::interval)         AS gaps_answered,
         (SELECT COUNT(*)::int FROM knowledge_gaps
           WHERE org_id = $1 AND status = 'open')                          AS gaps_open,
         (SELECT COALESCE(SUM(times_asked), 0)::int FROM knowledge_gaps
           WHERE org_id = $1 AND status = 'open')                          AS questions_missed`,
      [orgId, String(days)],
    );

    // Promises made and kept.
    //
    // A separate number from resolution rate, and arguably a harder one: a
    // business can resolve most conversations and still be the kind that says
    // "I'll get back to you" and doesn't. Customers forgive a wrong answer and
    // ask again; they do not forgive being left waiting, and until now that
    // failure was invisible in every metric here because the conversation
    // still looked resolved.
    //
    // 'cancelled' is excluded from the denominator: the customer stopped
    // needing the answer, which is not a promise the business broke.
    const promises = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('kept', 'broken'))::int AS settled,
         COUNT(*) FILTER (WHERE status = 'kept')::int              AS kept,
         COUNT(*) FILTER (WHERE status = 'broken')::int            AS broken,
         COUNT(*) FILTER (WHERE status = 'open')::int              AS open
       FROM commitments
      WHERE org_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
      [orgId, String(days)],
    );
    const p = promises.rows[0];

    // Takeovers, from the ledger's own negative signal rather than recomputed
    // here — one definition, in one place.
    const takeovers = await client.query(
      `SELECT COUNT(*)::int AS n FROM outcome_events
        WHERE org_id = $1 AND outcome_kind = 'human_took_over'
          AND occurred_at >= NOW() - ($2 || ' days')::interval`,
      [orgId, String(days)],
    );

    // Money.
    //
    // The AI/human split is decided by whether a PERSON spoke in the
    // conversation the outcome belongs to — read from messages, not from the
    // resolution metadata, because a conversation carrying a payment may still
    // be open and would otherwise be silently excluded.
    //
    // An outcome with no conversation cannot be attributed either way. It is
    // counted, and its money is reported as human-involved rather than
    // credited to the AI: revenue nobody can trace to an AI conversation must
    // never inflate the AI's number.
    const value = await client.query(
      `SELECT
         o.outcome_kind                       AS kind,
         o.value_numeric                      AS amount,
         o.value_currency                     AS currency,
         COALESCE(
           o.conversation_id IS NULL
           OR EXISTS (
             SELECT 1 FROM messages m
              WHERE m.org_id = o.org_id
                AND m.conversation_id = o.conversation_id
                AND m.role = 'human_agent'
           ), true)                           AS human_involved
       FROM outcome_events o
      WHERE o.org_id = $1
        AND o.outcome_kind IN ('meeting_booked', 'payment_received', 'deal_closed')
        AND o.occurred_at >= NOW() - ($2 || ' days')::interval`,
      [orgId, String(days)],
    );

    const money = summariseMoney(
      value.rows.map((r) => ({
        kind: r.kind,
        // NUMERIC arrives from pg as a string, on purpose — it is exact there
        // and lossy as a float. Converted once, here, rather than letting a
        // string reach the arithmetic and turn a sum into concatenation.
        amount: r.amount === null ? null : Number(r.amount),
        currency: r.currency,
        humanInvolved: Boolean(r.human_involved),
      })),
    );

    // Is there a control group? Almost always no, and the answer changes what
    // any of this is allowed to claim.
    const holdout = await client.query(
      `SELECT COUNT(*)::int AS n FROM agent_actions
        WHERE org_id = $1 AND arm = 'holdout'
          AND occurred_at >= NOW() - ($2 || ' days')::interval`,
      [orgId, String(days)],
    );

    const t = taught.rows[0];
    const deltaPp =
      current.autonomousPct !== null && previous.autonomousPct !== null
        ? Math.round((current.autonomousPct - previous.autonomousPct) * 10) / 10
        : null;

    return NextResponse.json({
      periodDays: days,
      current,
      previous,
      // Percentage POINTS, not percent. A move from 74% to 91% is 17 points,
      // not a 23% improvement, and the second framing is how honest numbers
      // turn into marketing ones.
      deltaPp,
      takeovers: takeovers.rows[0]?.n ?? 0,
      money: {
        counts: money.counts,
        // One entry per currency, each with its own autonomous share. Never a
        // single cross-currency total: adding rupees to dollars produces a
        // number that looks precise and means nothing.
        byCurrency: money.byCurrency.map((c) => ({
          ...c,
          autonomousPct: autonomousValuePct(c),
        })),
      },
      promises: {
        made: p.settled + p.open,
        kept: p.kept,
        broken: p.broken,
        open: p.open,
        // null, not 0, when nothing has been settled yet. A kept rate of 0%
        // and "no promises have come due" are opposite statements about a
        // business, and rendering the second as the first would be a serious
        // and very visible lie.
        keptPct: p.settled > 0 ? Math.round((p.kept / p.settled) * 1000) / 10 : null,
      },
      teaching: {
        corrections: t.corrections,
        gapsAnswered: t.gaps_answered,
        gapsOpen: t.gaps_open,
        questionsMissed: t.questions_missed,
      },
      causal: {
        holdoutActions: holdout.rows[0]?.n ?? 0,
        // False means: report movement, never attribute it. The API says so
        // rather than leaving each caller to remember.
        comparisonAvailable: (holdout.rows[0]?.n ?? 0) > 0,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[impact]', message);
    return NextResponse.json({ error: 'Could not load impact.' }, { status: 500 });
  } finally {
    client.release();
  }
}
