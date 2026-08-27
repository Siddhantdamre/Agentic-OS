'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { HelpCircle, Check, X } from 'lucide-react';

/**
 * What the agent could not answer — and the one-minute fix for each.
 *
 * WHY THIS COMPONENT EXISTS
 * Migration 025 has been recording every unanswerable question since it
 * shipped, written from two live call sites in WorkItemWorkflow. Nothing read
 * it: no API route, no page. The agent kept a careful list of everything it
 * did not know, in a table no human could see.
 *
 * That list is the most actionable output this product has. It is a business
 * being told, in its own customers' words and with a count attached, exactly
 * which handful of facts would make its AI employee useful. Answering one
 * takes a minute and permanently removes a class of failure — and the answer
 * lands in org_memory phrased the way customers actually ask.
 *
 * Ranked by how many times each was asked, because that count is the only
 * priority signal that matters.
 */

type Gap = {
  id: string;
  question: string;
  agentReply: string;
  timesAsked: number;
  lastSeenAt: string;
};

export function KnowledgeGaps() {
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [openGaps, setOpenGaps] = useState(0);
  const [questionsMissed, setQuestionsMissed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/knowledge-gaps?status=open');
      if (!res.ok) { setGaps([]); return; }
      const json = await res.json();
      setGaps(Array.isArray(json.gaps) ? json.gaps : []);
      setOpenGaps(Number(json.openGaps) || 0);
      setQuestionsMissed(Number(json.questionsMissed) || 0);
    } catch {
      setGaps([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async (gapId: string, body: Record<string, unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/knowledge-gaps/${gapId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) { setNote(json.error || 'Could not save that.'); return; }
      setNote(
        json.status === 'resolved'
          ? 'Saved. The agent can answer this now.'
          : 'Dismissed — the agent will not be asked to learn this.'
      );
      setAnswering(null);
      setAnswer('');
      await load();
    } catch {
      setNote('Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  // An empty list is genuinely good news, and saying so is better than showing
  // an empty box that reads like something failed to load.
  if (!loading && gaps.length === 0) {
    return (
      <section className="rounded-2xl border border-emerald-900/40 bg-[#16201D]/40 p-5">
        <div className="flex items-center gap-2">
          <HelpCircle className="w-4 h-4 text-emerald-500" />
          <h2 className="text-sm font-bold text-heading">Questions the agent could not answer</h2>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          None right now. Every customer question in the last period was answered
          from what this business has taught it.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <HelpCircle className="w-4 h-4 text-amber-600 mt-0.5" />
          <div>
            <h2 className="text-sm font-bold text-heading">Questions the agent could not answer</h2>
            <p className="text-xs text-slate-500 mt-1">
              {openGaps} thing{openGaps === 1 ? '' : 's'} it does not know, costing{' '}
              {questionsMissed} customer question{questionsMissed === 1 ? '' : 's'} so far.
              Answer one and it never misses that again.
            </p>
          </div>
        </div>
      </div>

      {note && (
        <div className="rounded-xl border border-emerald-900/60 bg-[#1C2825] px-3 py-2 text-[11px] text-emerald-200">
          {note}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : (
        <ul className="space-y-3">
          {gaps.map((gap) => (
            <li key={gap.id} className="rounded-xl border border-slate-700/40 bg-[#16201D]/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-heading font-medium leading-relaxed">{gap.question}</p>
                <span className="shrink-0 text-[10px] font-bold text-amber-600 bg-amber-500/15 rounded-full px-2 py-0.5">
                  asked {gap.timesAsked}×
                </span>
              </div>

              {gap.agentReply && (
                // Shown because the miss is sometimes a RETRIEVAL failure, not a
                // knowledge gap — the fact is already in the brain and was not
                // found. An operator can only tell those apart by reading what
                // the agent actually said.
                <p className="text-[11px] text-slate-500 mt-2 italic leading-relaxed">
                  It said: “{gap.agentReply.slice(0, 180)}{gap.agentReply.length > 180 ? '…' : ''}”
                </p>
              )}

              {answering === gap.id ? (
                <div className="mt-3 space-y-2">
                  <textarea
                    rows={3}
                    autoFocus
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder="Write the answer as you would tell a customer…"
                    className="w-full bg-[#1C2825] border border-amber-500/40 rounded-xl px-3 py-2 text-xs text-emerald-100 placeholder-slate-600 focus:outline-none focus:border-amber-500 leading-relaxed"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy || answer.trim().length < 20}
                      onClick={() => void submit(gap.id, { answer })}
                      className="bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-[#16201D] font-bold text-[11px] px-3 py-1.5 rounded-lg flex items-center gap-1.5"
                    >
                      <Check className="w-3 h-3" /> Teach the agent
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setAnswering(null); setAnswer(''); }}
                      className="text-[11px] text-slate-400 hover:text-slate-200 px-2"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 mt-3">
                  <button
                    type="button"
                    onClick={() => { setAnswering(gap.id); setAnswer(''); setNote(null); }}
                    className="text-[11px] font-bold text-amber-600 hover:text-amber-500"
                  >
                    Answer this
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void submit(gap.id, { dismiss: true })}
                    className="text-[11px] text-slate-500 hover:text-slate-300 flex items-center gap-1"
                  >
                    <X className="w-3 h-3" /> Not our business to know
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
