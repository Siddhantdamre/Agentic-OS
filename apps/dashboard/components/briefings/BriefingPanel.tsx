'use client';

import React, { useEffect, useState } from 'react';
import { Sunrise, AlertCircle } from 'lucide-react';

/**
 * What the agents did while nobody was watching.
 *
 * This is the surface for OwnerBriefingWorkflow, which runs itself daily and
 * persists a briefing whether or not anyone opens the dashboard. Before this
 * panel the workflow had never been started and its table had never held a row,
 * so "your AI employees work overnight" was a claim with nothing behind it.
 *
 * Deliberately shows the agent's own words rather than re-deriving the numbers.
 * A briefing is a record of what the agent understood at the time it looked; a
 * panel that recomputed today's figures and presented them as this morning's
 * briefing would be a different, less honest thing.
 */

interface Briefing {
  id: string;
  at: string;
  narrative: string;
  needsAttention: number;
  gaps: string[];
}

const when = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
};

export function BriefingPanel() {
  const [briefings, setBriefings] = useState<Briefing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/briefings?limit=5')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then((b) => setBriefings(b.briefings || []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <section className="bg-white border border-cream-300 rounded-2xl p-6">
        <h2 className="font-serif font-bold text-heading flex items-center gap-2 mb-2">
          <Sunrise className="w-4 h-4 text-amber-500" /> What happened overnight
        </h2>
        <p className="text-sm text-amber-800">{error}</p>
      </section>
    );
  }

  const latest = briefings?.[0];
  const earlier = (briefings || []).slice(1);

  return (
    <section className="bg-white border border-cream-300 rounded-2xl p-6 space-y-4">
      <div>
        <h2 className="font-serif font-bold text-heading flex items-center gap-2">
          <Sunrise className="w-4 h-4 text-amber-500" /> What happened overnight
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Written by the agent each morning, whether or not anyone opens this page.
        </p>
      </div>

      {briefings === null && <p className="text-sm text-slate-400">Loading…</p>}

      {briefings !== null && !latest && (
        <p className="text-sm text-slate-500 leading-relaxed">
          No briefing yet. The first one appears after the daily run — nothing is
          invented to fill this space in the meantime.
        </p>
      )}

      {latest && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
              {when(latest.at)}
            </span>
            {latest.needsAttention > 0 && (
              <span className="text-[11px] font-semibold text-amber-800 bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 rounded-md inline-flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {latest.needsAttention} need{latest.needsAttention === 1 ? 's' : ''} a person
              </span>
            )}
          </div>
          <p className="text-sm text-slate-700 leading-relaxed">{latest.narrative}</p>

          {latest.gaps.length > 0 && (
            <div className="pt-1">
              <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                It could not answer
              </span>
              <ul className="mt-1 space-y-0.5">
                {latest.gaps.slice(0, 4).map((g, i) => (
                  <li key={i} className="text-xs text-slate-600">— {g}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {earlier.length > 0 && (
        <div className="pt-2 border-t border-cream-300 space-y-1.5">
          <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
            Earlier
          </span>
          {earlier.map((b) => (
            <div key={b.id} className="flex items-baseline gap-3">
              <span className="text-xs text-slate-400 font-mono shrink-0 w-32">{when(b.at)}</span>
              <span className="text-xs text-slate-600 truncate">{b.narrative}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
