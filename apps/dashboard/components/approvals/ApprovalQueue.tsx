'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Check, X, Lock } from 'lucide-react';

/**
 * What the agent is waiting to be allowed to do — and what it has earned.
 *
 * WHY THIS EXISTS
 * Measured before it did:
 *
 *   waiting_approval  24     confirm_requested  24     confirm_approved  0
 *
 * The oldest had been waiting thirteen days. The workflow defined the approve
 * signal and handled it correctly; nothing could send it. The agent asked
 * twenty-four times into a void.
 *
 * WHY THE DRAFT IS SHOWN IN FULL
 * An approval screen that says "approve this action?" is one people click
 * through without reading, and a gate everyone clicks through is worse than no
 * gate — it launders responsibility without adding judgement. If a person is
 * being asked to take responsibility, they have to be shown the thing.
 */

type Pending = {
  id: string;
  actionClass: string;
  summary: string;
  draft: string;
  createdAt: string;
  contactId: string | null;
};

type Autonomy = {
  actionClass: string;
  level: 'ask' | 'notify' | 'silent';
  consecutiveApprovals: number;
  totalApprovals: number;
  totalRejections: number;
  mayGraduate: boolean;
  threshold: number;
};

const LEVEL_COPY: Record<string, string> = {
  ask: 'asks you first',
  notify: 'does it, then tells you',
  silent: 'does it quietly',
};

export function ApprovalQueue() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [autonomy, setAutonomy] = useState<Autonomy[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/approvals');
      if (!res.ok) { setPending([]); return; }
      const json = await res.json();
      setPending(Array.isArray(json.pending) ? json.pending : []);
      setAutonomy(Array.isArray(json.autonomy) ? json.autonomy : []);
    } catch {
      setPending([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (id: string, decision: 'approved' | 'rejected', why = '') => {
    setBusy(id);
    setNote(null);
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reason: why }),
      });
      const json = await res.json();
      if (!res.ok) { setNote(json.error || 'Could not record that.'); return; }
      setNote(
        json.promoted
          // A promotion changes how the agent behaves from here on. Nobody
          // should discover that by noticing it stopped asking.
          ? `Done. You have approved "${json.actionClass}" enough times that the agent will now ${LEVEL_COPY[json.autonomyLevel] || 'act'} — you can undo that below at any time.`
          : decision === 'rejected'
            ? 'Rejected. The agent will keep asking about this.'
            : 'Approved.'
      );
      setRejecting(null);
      setReason('');
      await load();
    } catch {
      setNote('Could not record that.');
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async () => {
    setBusy('revoke');
    try {
      await fetch('/api/approvals/revoke', { method: 'POST' });
      setNote('Everything is back to asking you first.');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const granted = autonomy.filter((a) => a.level !== 'ask');

  if (loading) {
    return <div className="h-32 rounded-2xl bg-cream-200/50 border border-cream-300 animate-pulse" />;
  }

  return (
    <section className="rounded-2xl border border-cream-300 bg-white p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <ShieldCheck className="w-4 h-4 text-amber-600 mt-0.5" />
          <div>
            <h2 className="text-sm font-bold text-heading">Waiting on you</h2>
            <p className="text-xs text-slate-500 mt-1">
              {pending.length === 0
                ? 'Nothing is waiting. The agent has not needed permission for anything.'
                : `${pending.length} thing${pending.length === 1 ? '' : 's'} the agent will not do without you.`}
            </p>
          </div>
        </div>
      </div>

      {note && (
        <div className="rounded-xl border border-emerald-900/30 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          {note}
        </div>
      )}

      {pending.map((p) => (
        <div key={p.id} className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-500/15 rounded px-1.5 py-0.5">
                {p.actionClass}
              </span>
              <p className="text-xs text-heading mt-2 leading-relaxed">{p.summary}</p>
            </div>
            <span suppressHydrationWarning className="shrink-0 text-[10px] text-slate-400">
              {new Date(p.createdAt).toLocaleString()}
            </span>
          </div>

          {/* Shown in full. A gate people click through without reading is
              worse than no gate. */}
          {p.draft && (
            <pre className="text-[11px] text-slate-700 bg-white border border-cream-300 rounded-lg p-3 whitespace-pre-wrap leading-relaxed">
              {p.draft}
            </pre>
          )}

          {rejecting === p.id ? (
            <div className="space-y-2">
              <input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why not? The agent learns from this."
                className="w-full bg-white border border-red-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-red-500"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy === p.id || reason.trim().length < 3}
                  onClick={() => void decide(p.id, 'rejected', reason)}
                  className="bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white font-bold text-[11px] px-3 py-1.5 rounded-lg"
                >
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => { setRejecting(null); setReason(''); }}
                  className="text-[11px] text-slate-500 hover:text-slate-700 px-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => void decide(p.id, 'approved')}
                className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-[11px] px-3 py-1.5 rounded-lg flex items-center gap-1.5"
              >
                <Check className="w-3 h-3" /> Approve
              </button>
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => { setRejecting(p.id); setReason(''); setNote(null); }}
                className="text-[11px] text-slate-600 hover:text-red-600 flex items-center gap-1 px-2"
              >
                <X className="w-3 h-3" /> Reject
              </button>
            </div>
          )}
        </div>
      ))}

      {/* What it has earned, and how to take it back. */}
      {autonomy.length > 0 && (
        <div className="border-t border-cream-300 pt-4 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-heading">What it can do on its own</h3>
            {granted.length > 0 && (
              // One button, one call, effective on the next action. The person
              // reaching for this is not in a state to reason about classes.
              <button
                type="button"
                disabled={busy === 'revoke'}
                onClick={() => void revokeAll()}
                className="text-[11px] font-bold text-red-600 hover:text-red-500"
              >
                Make it ask me again for everything
              </button>
            )}
          </div>
          {autonomy.map((a) => (
            <div key={a.actionClass} className="flex items-center gap-2 text-xs text-slate-600">
              <span className="font-mono text-[11px] text-heading w-20">{a.actionClass}</span>
              <span>{LEVEL_COPY[a.level]}</span>
              {!a.mayGraduate ? (
                <span className="flex items-center gap-1 text-[10px] text-slate-400">
                  <Lock className="w-3 h-3" /> always asks — money, contracts and compliance never change
                </span>
              ) : a.level === 'ask' ? (
                <span className="text-[10px] text-slate-400">
                  {a.consecutiveApprovals}/{a.threshold} approvals toward doing this on its own
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
