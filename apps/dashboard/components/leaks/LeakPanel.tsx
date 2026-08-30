'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, Zap, ShieldCheck } from 'lucide-react';

/**
 * Where money is walking out that nobody can see.
 *
 * A business knows about the deal it lost — somebody said no, and that is a
 * fact with a shape. It does not know about the lead who enquired and was
 * never contacted again, the question that had no answer, or the promise
 * nobody wrote down. Those leave no mark anywhere, which is exactly why they
 * are the largest losses and the ones nobody fixes.
 *
 * ── THE REFUSALS ARE THE PRODUCT ──────────────────────────────────────────
 * The first thing an owner wants to know about an agent that messages their
 * customers is not who it contacted. It is who it DIDN'T. "Did you message the
 * man complaining about his refund?" — and the answer has to be "no, here is
 * the row, here is why". So the left-alone list is rendered as prominently as
 * the send list, not folded behind a details link.
 *
 * ── NO RUPEE FIGURES ──────────────────────────────────────────────────────
 * "You are losing ₹4.2L a month" would be the most persuasive sentence on this
 * screen and it would be invented. A quiet lead is not a lost sale; it is a
 * lead nobody followed up. The counts are real; the arithmetic about what they
 * are worth belongs to the person who knows their own conversion rate.
 */

type Leak = {
  key: string;
  count: number;
  headline: string;
  why: string;
  action: string | null;
};

type Proposed = {
  id: string;
  conversationId: string;
  quietDays: number;
  nudgeNumber: number;
  draft: string;
};

type LeakReport = {
  mode: 'off' | 'dry_run' | 'on';
  leaks: Leak[];
  followUps: {
    proposed: Proposed[];
    suppressedCount: number;
    sentCount: number;
    refusedByReason: Record<string, number>;
    revival: { sent: number; replied: number; replyRatePct: number | null; headline: string };
  };
};

/** Plain English for a machine-readable refusal code. */
const REFUSAL_LABEL: Record<string, string> = {
  customer_declined: 'said they are not going ahead',
  complaint: 'was complaining, not enquiring',
  already_nudged_enough: 'has already been followed up twice',
  opted_out: 'asked not to be contacted',
  awaiting_us: 'is waiting on your reply, not the other way round',
  too_old: 'went quiet too long ago to follow up naturally',
  not_quiet_yet: 'only just went quiet',
  resolved: 'is already closed',
  no_customer_message: 'never actually wrote to you',
};

const MODE_COPY: Record<string, { label: string; blurb: string }> = {
  off: { label: 'Off', blurb: 'Nothing is drafted and nothing is sent.' },
  dry_run: {
    label: 'Watching',
    blurb: 'It drafts every follow-up and sends none, so you can read what it would have said.',
  },
  on: {
    label: 'Following up',
    blurb: 'It contacts quiet leads. Never twice, never after a no, never during a complaint.',
  },
};

export function LeakPanel() {
  const [data, setData] = useState<LeakReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/leaks');
      setData(res.ok ? await res.json() : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setMode = async (mode: 'off' | 'dry_run' | 'on') => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/leaks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const json = await res.json();
      setNote(json.message || json.error || null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="h-40 rounded-2xl bg-cream-200/50 border border-cream-300 animate-pulse" />;
  }
  if (!data) return null;

  const { mode, leaks, followUps } = data;
  const refusals = Object.entries(followUps.refusedByReason || {}).sort((a, b) => b[1] - a[1]);
  const totalLeaks = leaks.reduce((a, l) => a + l.count, 0);

  return (
    <section className="rounded-2xl border border-cream-300 bg-white p-6 space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-heading">Where you are losing business</h2>
          <p className="text-xs text-slate-500 mt-1 max-w-lg leading-relaxed">
            Not the deals you lost — you know about those. These are the ones that leave
            no record anywhere, because nothing happened.
          </p>
        </div>
        {totalLeaks > 0 && (
          <span className="text-3xl font-serif font-bold text-heading tabular-nums">{totalLeaks}</span>
        )}
      </div>

      {/* ── The leaks ──────────────────────────────────────────────────── */}
      <div className="grid gap-px bg-cream-300 border border-cream-300 rounded-xl overflow-hidden sm:grid-cols-2">
        {leaks.map((l) => (
          <div key={l.key} className="bg-white p-4">
            <div className="flex items-baseline gap-2">
              <span className={`text-2xl font-bold tabular-nums ${l.count > 0 ? 'text-heading' : 'text-slate-300'}`}>
                {l.count}
              </span>
              <span className="text-xs font-semibold text-heading leading-snug">{l.headline}</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">{l.why}</p>
          </div>
        ))}
      </div>

      {/* ── The follow-up agent ────────────────────────────────────────── */}
      <div className="border-t border-cream-300 pt-5 space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-2">
            {mode === 'on' ? <Zap className="w-4 h-4 text-amber-600 mt-0.5" />
              : mode === 'dry_run' ? <Eye className="w-4 h-4 text-amber-600 mt-0.5" />
                : <EyeOff className="w-4 h-4 text-slate-400 mt-0.5" />}
            <div>
              <h3 className="text-xs font-bold text-heading">
                Following up the ones who went quiet
              </h3>
              <p className="text-[11px] text-slate-500 mt-1 max-w-md">
                {MODE_COPY[mode]?.blurb}
              </p>
            </div>
          </div>

          {/* Three states, not a toggle. "Watching" is what makes this safe to
              adopt: a fortnight of drafts before it says anything. */}
          <div className="flex rounded-lg border border-cream-300 overflow-hidden shrink-0">
            {(['off', 'dry_run', 'on'] as const).map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy}
                onClick={() => void setMode(m)}
                aria-pressed={mode === m}
                className={`text-[11px] font-bold px-3 py-1.5 transition ${
                  mode === m
                    ? 'bg-amber-500 text-[#16201D]'
                    : 'bg-white text-slate-600 hover:text-amber-700'
                }`}
              >
                {MODE_COPY[m]?.label}
              </button>
            ))}
          </div>
        </div>

        {note && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-slate-700">
            {note}
          </div>
        )}

        {/* The outcome. Never a percentage from a handful — the shared module
            refuses below ten sends, and this renders whatever it says. */}
        {followUps.revival.sent > 0 && (
          <p className="text-xs text-slate-600">{followUps.revival.headline}</p>
        )}

        {/* ── What it wants to send ─────────────────────────────────────── */}
        {followUps.proposed.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
              Waiting for you — {followUps.proposed.length}
            </h4>
            {followUps.proposed.slice(0, 4).map((p) => (
              <div key={p.id} className="rounded-xl border border-cream-300 bg-cream-50/50 p-3">
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  quiet {p.quietDays} days · follow-up {p.nudgeNumber} of 2
                </div>
                <p className="text-[11px] text-heading mt-1.5 leading-relaxed">{p.draft}</p>
              </div>
            ))}
            {followUps.proposed.length > 4 && (
              <p className="text-[11px] text-slate-400">
                and {followUps.proposed.length - 4} more.
              </p>
            )}
          </div>
        )}

        {mode === 'dry_run' && followUps.suppressedCount > 0 && (
          <p className="text-[11px] text-slate-500">
            {followUps.suppressedCount} drafted and deliberately not sent while you watch.
          </p>
        )}

        {/* ── THE REFUSALS. Rendered first-class, not hidden. ───────────── */}
        {refusals.length > 0 && (
          <div className="rounded-xl border border-emerald-600/20 bg-emerald-50/40 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" />
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-emerald-800">
                Deliberately left alone
              </h4>
            </div>
            <ul className="space-y-1">
              {refusals.map(([reason, n]) => (
                <li key={reason} className="text-[11px] text-slate-700">
                  <span className="font-bold tabular-nums">{n}</span>{' '}
                  {n === 1 ? 'person who ' : 'people who '}
                  {REFUSAL_LABEL[reason] || reason}
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-slate-500 pt-1">
              The agent will not contact any of these, however long they stay quiet.
            </p>
          </div>
        )}

        {mode === 'off' && followUps.proposed.length === 0 && (
          <p className="text-xs text-slate-500 leading-relaxed">
            Switch to <span className="font-semibold">Watching</span> for a fortnight. It will
            draft a follow-up for every lead that went quiet and send none of them, so you can
            read exactly what it would have said — and see who it refused to contact — before
            deciding whether to let it act.
          </p>
        )}
      </div>
    </section>
  );
}
