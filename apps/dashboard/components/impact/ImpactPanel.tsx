'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, GraduationCap } from 'lucide-react';

/**
 * What the AI actually did, and whether it is getting better.
 *
 * WHY THIS PANEL EXISTS
 * The outcome ledger was built, tested and never executed or read. So the one
 * question that decides a renewal — what did this do for us? — had no answer
 * in the product.
 *
 * WHAT IT REFUSES TO DO
 * It does not show reply counts. A business can already see its inbox is busy;
 * activity is not value. The headline is the share of conversations that
 * finished without a person, because that is the work that stopped needing
 * someone, and it is the only number that justifies paying every month.
 *
 * It does not claim causation. Teaching and the trend sit beside each other
 * and the copy says "moved together", never "caused". Without a holdout arm
 * there is no control group, and saying otherwise would be the easiest lie in
 * the product to tell and the hardest for a customer to catch.
 */

type Period = {
  handled: number;
  autonomous: number;
  withHuman: number;
  stillOpen: number;
  closed: number;
  autonomousPct: number | null;
};

type Impact = {
  periodDays: number;
  current: Period;
  previous: Period;
  deltaPp: number | null;
  takeovers: number;
  promises: { made: number; kept: number; broken: number; open: number; keptPct: number | null };
  money: {
    counts: {
      meetingsBooked: number; paymentsReceived: number; dealsClosed: number;
      withAmount: number; withoutAmount: number;
    };
    byCurrency: Array<{
      currency: string; withoutHuman: number; withHuman: number;
      total: number; autonomousPct: number | null;
    }>;
  };
  teaching: { corrections: number; gapsAnswered: number; gapsOpen: number; questionsMissed: number };
  causal: { holdoutActions: number; comparisonAvailable: boolean };
};

export function ImpactPanel({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<Impact | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/impact?days=${days}`);
      setData(res.ok ? await res.json() : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="h-40 rounded-2xl bg-cream-200/50 border border-cream-300 animate-pulse" />;
  }
  if (!data) return null;

  const { current, previous, deltaPp, teaching, causal } = data;
  const taughtTotal = teaching.corrections + teaching.gapsAnswered;

  // Nothing has closed yet. Say that, rather than rendering 0% — a rate of
  // zero is a claim about performance, and "not measured yet" is the truth.
  if (current.closed === 0) {
    return (
      <section className="rounded-2xl border border-cream-300 bg-white p-5">
        <h2 className="text-sm font-bold text-heading">Impact</h2>
        <p className="text-xs text-slate-500 mt-2 leading-relaxed">
          No conversations from the last {data.periodDays} days have finished yet.
          A conversation counts as finished once the customer has stopped
          replying for a day — so the first numbers appear tomorrow, not
          immediately.
        </p>
      </section>
    );
  }

  const Trend = deltaPp === null || deltaPp === 0 ? Minus : deltaPp > 0 ? TrendingUp : TrendingDown;
  const trendColor =
    deltaPp === null || deltaPp === 0 ? 'text-slate-400' : deltaPp > 0 ? 'text-emerald-600' : 'text-red-500';

  return (
    <section className="rounded-2xl border border-cream-300 bg-white p-6 space-y-5">
      <div>
        <h2 className="text-sm font-bold text-heading">Impact — last {data.periodDays} days</h2>
        <p className="text-xs text-slate-500 mt-1">
          How much customer work finished without a person.
        </p>
      </div>

      <div className="flex items-end gap-6 flex-wrap">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-serif font-bold text-heading">
              {current.autonomousPct}%
            </span>
            <span className={`flex items-center gap-1 text-xs font-bold ${trendColor}`}>
              <Trend className="w-3.5 h-3.5" />
              {deltaPp === null
                ? 'no prior period'
                : `${deltaPp > 0 ? '+' : ''}${deltaPp} pts`}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            handled start to finish with no human message
          </p>
        </div>

        <div className="text-xs text-slate-600 space-y-1">
          <div>
            <span className="font-bold text-heading">{current.autonomous}</span> resolved by the agent alone
          </div>
          <div>
            {/* Never netted out of the headline. The 9% is the honest half. */}
            <span className="font-bold text-heading">{current.withHuman}</span> needed a person
            {data.takeovers > 0 && (
              <span className="text-slate-400"> · {data.takeovers} takeover{data.takeovers === 1 ? '' : 's'}</span>
            )}
          </div>
          {current.stillOpen > 0 && (
            <div className="text-slate-400">
              {current.stillOpen} still open — not counted either way yet
            </div>
          )}
        </div>
      </div>

      {/*
        Promises kept, beside resolution rate and never folded into it.
        A business can resolve most conversations and still be the kind that
        says "I'll get back to you" and doesn't — customers forgive a wrong
        answer and ask again, and do not forgive being left waiting.
      */}
      {data.promises?.keptPct !== null && data.promises?.made > 0 && (
        <div className="flex items-baseline gap-3 border-t border-cream-300 pt-4">
          <span className="text-2xl font-serif font-bold text-heading">
            {data.promises.keptPct}%
          </span>
          <span className="text-xs text-slate-600">
            of promises kept — {data.promises.kept} of{' '}
            {data.promises.kept + data.promises.broken} that came due
            {data.promises.open > 0 && (
              <span className="text-slate-400"> · {data.promises.open} still within time</span>
            )}
          </span>
        </div>
      )}
      {data.promises?.keptPct === null && data.promises?.open > 0 && (
        <p className="text-xs text-slate-500 border-t border-cream-300 pt-4">
          {data.promises.open} promise{data.promises.open === 1 ? '' : 's'} made and still
          within time. None has come due yet, so there is no kept rate to show.
        </p>
      )}

      {/*
        Money, per currency and never added across them.
        "84% resolved" is a good number; "₹4,20,000 of value with nobody
        stepping in" is a different conversation. Shown only when there is
        something to show — a money section reading zero on a business that
        has not connected any of this reads as failure rather than absence.
      */}
      {(data.money?.byCurrency?.length > 0 || data.money?.counts?.meetingsBooked > 0
        || data.money?.counts?.dealsClosed > 0 || data.money?.counts?.paymentsReceived > 0) && (
        <div className="border-t border-cream-300 pt-4 space-y-3">
          <h3 className="text-xs font-bold text-heading">Value it moved</h3>

          {data.money.byCurrency.map((c) => (
            <div key={c.currency} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-serif font-bold text-heading">
                {/* Formatted in the currency's own convention — Indian grouping
                    for INR reads as ₹4,20,000, not ₹420,000. */}
                {new Intl.NumberFormat(c.currency === 'INR' ? 'en-IN' : 'en-US',
                  { style: 'currency', currency: c.currency, maximumFractionDigits: 0 })
                  .format(c.withoutHuman)}
              </span>
              <span className="text-xs text-slate-600">
                {c.autonomousPct === null
                  ? 'recorded, with no value attached'
                  : <>handled with nobody stepping in — {c.autonomousPct}% of{' '}
                      {new Intl.NumberFormat(c.currency === 'INR' ? 'en-IN' : 'en-US',
                        { style: 'currency', currency: c.currency, maximumFractionDigits: 0 })
                        .format(c.total)} total</>}
              </span>
            </div>
          ))}

          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
            {data.money.counts.meetingsBooked > 0 && (
              <span><span className="font-bold text-heading">{data.money.counts.meetingsBooked}</span> meeting{data.money.counts.meetingsBooked === 1 ? '' : 's'} booked</span>
            )}
            {data.money.counts.paymentsReceived > 0 && (
              <span><span className="font-bold text-heading">{data.money.counts.paymentsReceived}</span> payment{data.money.counts.paymentsReceived === 1 ? '' : 's'} received</span>
            )}
            {data.money.counts.dealsClosed > 0 && (
              <span><span className="font-bold text-heading">{data.money.counts.dealsClosed}</span> deal{data.money.counts.dealsClosed === 1 ? '' : 's'} closed</span>
            )}
          </div>

          {data.money.counts.withoutAmount > 0 && (
            // Said out loud. Silently omitting outcomes with no figure would
            // make the total look like the whole picture when it is not.
            <p className="text-xs text-slate-400">
              {data.money.counts.withoutAmount} of these carried no amount, so they are counted
              but not included in the value above.
            </p>
          )}

          {!causal.comparisonAvailable && data.money.byCurrency.length > 0 && (
            <p className="text-xs text-slate-500">
              This is value that moved through conversations the AI handled. Without a
              control group we cannot say it would not have happened anyway.
            </p>
          )}
        </div>
      )}

      {previous.autonomousPct !== null && (
        <p className="text-xs text-slate-500">
          Previous {data.periodDays} days: {previous.autonomousPct}% of {previous.closed} finished
          conversations.
        </p>
      )}

      {taughtTotal > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2">
            <GraduationCap className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <div className="text-xs text-slate-700 leading-relaxed">
              <span className="font-bold text-heading">
                Your team taught it {taughtTotal} thing{taughtTotal === 1 ? '' : 's'}
              </span>{' '}
              this period — {teaching.corrections} correction
              {teaching.corrections === 1 ? '' : 's'} and {teaching.gapsAnswered} answered
              question{teaching.gapsAnswered === 1 ? '' : 's'}.
              {deltaPp !== null && deltaPp > 0 && (
                <>
                  {' '}Autonomous resolution moved {deltaPp > 0 ? 'up' : 'down'} {Math.abs(deltaPp)} points
                  over the same period.
                </>
              )}
              {/*
                The caveat is not fine print. Without a holdout these two facts
                moved together and nothing more can be said, and a business
                that later discovers the difference will not trust the rest of
                the dashboard either.
              */}
              {!causal.comparisonAvailable && (
                <span className="block text-slate-500 mt-1">
                  These moved together over the same weeks. There is no control
                  group here, so this is not proof that one caused the other.
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {teaching.gapsOpen > 0 && (
        <p className="text-xs text-slate-600">
          <span className="font-bold text-heading">{teaching.gapsOpen}</span> thing
          {teaching.gapsOpen === 1 ? '' : 's'} it still does not know, costing{' '}
          {teaching.questionsMissed} customer question
          {teaching.questionsMissed === 1 ? '' : 's'}.{' '}
          <a href="/brain" className="text-amber-600 font-bold hover:underline">
            Answer them
          </a>{' '}
          and this number goes up.
        </p>
      )}
    </section>
  );
}
