'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Would the agent have done what you did?
 *
 * The one number that answers "I don't trust it" with evidence instead of a
 * demo — and the only one in this product a competitor cannot show, because
 * nobody else stores what the agent proposed beside what the human actually
 * did.
 *
 * THE DISAGREEMENTS ARE THE POINT.
 * A dashboard that shows 94% and hides the 6% is a brochure. The three cases
 * it got wrong are what a business reads, what turns into a correction, and
 * what makes the 94% believable at all. They are rendered first-class, not
 * behind a "view details" link.
 */

type Disagreement = {
  source: 'reply' | 'approval';
  proposed: string;
  humanOutcome: string;
  reason?: string;
  at?: string;
};

type Shadow = {
  shadowMode: { enabled: boolean; startedAt: string | null };
  decided: number;
  agreed: number;
  cosmetic: number;
  disagreed: number;
  agreementPct: number | null;
  disagreements: Disagreement[];
  bySource: { reply: { decided: number; agreed: number }; approval: { decided: number; agreed: number } };
  headline: string;
};

export function ShadowPanel({ days = 30 }: { days?: number }) {
  const [data, setData] = useState<Shadow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/shadow?days=${days}`);
      setData(res.ok ? await res.json() : null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/shadow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      setNote(json.message || null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="h-32 rounded-2xl bg-cream-200/50 border border-cream-300 animate-pulse" />;
  }
  if (!data) return null;

  const on = data.shadowMode.enabled;

  return (
    <section className="rounded-2xl border border-cream-300 bg-white p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          {on ? <Eye className="w-4 h-4 text-amber-600 mt-0.5" /> : <EyeOff className="w-4 h-4 text-slate-400 mt-0.5" />}
          <div>
            <h2 className="text-sm font-bold text-heading">Would it have done what you did?</h2>
            <p className="text-xs text-slate-500 mt-1">
              {on
                ? 'Shadow mode is on. The agent is drafting everything and sending nothing.'
                : 'Measured from the replies you edited and the actions you approved.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void toggle(!on)}
          className={`shrink-0 text-[11px] font-bold px-3 py-1.5 rounded-lg transition ${
            on ? 'bg-amber-500 text-[#16201D] hover:bg-amber-400'
               : 'border border-cream-300 text-slate-600 hover:border-amber-500 hover:text-amber-700'
          }`}
        >
          {on ? 'Let it send again' : 'Watch it for a while'}
        </button>
      </div>

      {note && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-slate-700">
          {note}
        </div>
      )}

      {/* The headline comes from the shared module, so the wording — "agreed
          with you", never "was right" — cannot drift from what the tests pin. */}
      <div className="flex items-baseline gap-3 flex-wrap">
        {data.agreementPct !== null && (
          <span className="text-4xl font-serif font-bold text-heading">{data.agreementPct}%</span>
        )}
        <p className="text-xs text-slate-600 leading-relaxed max-w-xl">{data.headline}</p>
      </div>

      {data.decided > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
          <span><span className="font-bold text-heading">{data.bySource.reply.agreed}</span>
            {' '}of {data.bySource.reply.decided} replies you sent as written</span>
          <span><span className="font-bold text-heading">{data.bySource.approval.agreed}</span>
            {' '}of {data.bySource.approval.decided} actions you approved</span>
          {data.cosmetic > 0 && (
            // Shown separately so the headline can never hide how much tidying
            // is going on behind a flattering total.
            <span className="text-slate-400">{data.cosmetic} needed only a tidy-up</span>
          )}
        </div>
      )}

      {/* The 6%. A dashboard that shows the 94% and hides these is a brochure. */}
      {data.disagreements.length > 0 && (
        <div className="border-t border-cream-300 pt-4 space-y-3">
          <h3 className="text-xs font-bold text-heading">
            Where you disagreed — {data.disagreed} time{data.disagreed === 1 ? '' : 's'}
          </h3>
          {data.disagreements.slice(0, 5).map((d, i) => (
            <div key={i} className="rounded-xl border border-cream-300 bg-cream-50/50 p-3 space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                {d.source === 'reply' ? 'it drafted' : 'it wanted to act'}
              </div>
              <p className="text-[11px] text-slate-600 leading-relaxed line-clamp-3">{d.proposed}</p>
              <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                {d.source === 'reply' ? 'you sent' : `you ${d.humanOutcome}`}
              </div>
              {d.source === 'reply' ? (
                <p className="text-[11px] text-heading leading-relaxed line-clamp-3">{d.humanOutcome}</p>
              ) : d.reason ? (
                <p className="text-[11px] text-heading leading-relaxed">{d.reason}</p>
              ) : null}
            </div>
          ))}
          {data.disagreements.length > 5 && (
            <p className="text-[11px] text-slate-400">
              and {data.disagreements.length - 5} more.
            </p>
          )}
        </div>
      )}

      {data.decided === 0 && (
        <p className="text-xs text-slate-500">
          Turn on watching for a week or two. The agent will draft every reply and send
          nothing, so you can see exactly what it would have done before deciding how much
          to let it do on its own.
        </p>
      )}
    </section>
  );
}
