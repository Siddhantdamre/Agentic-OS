'use client';

/**
 * ASK A BUSINESS QUESTION, GET BOTH SIDES — OR AN HONEST REFUSAL.
 *
 * The page exists to make one behaviour visible: when this workspace's own
 * records and the outside market disagree, the brief shows BOTH figures and
 * withholds the recommendation. It never averages them.
 *
 * So the verdict banner is the first thing rendered, at full width, in the
 * colour of its kind — green for an answer, amber for a disagreement, slate
 * for a refusal. A reader who looks at nothing else must not come away with a
 * recommendation the evidence does not support.
 */

import React, { useState } from 'react';
import {
  Scale,
  Building2,
  Globe,
  AlertTriangle,
  CheckCircle2,
  MinusCircle,
  Loader2,
  ExternalLink,
} from 'lucide-react';

type Basis = 'both' | 'conflict' | 'internal' | 'external';

interface ExternalSource {
  url: string;
  title?: string;
}

interface Finding {
  claim: string;
  basis: Basis;
  confidence: string;
  caveat: string;
  internalSources: string[];
  externalSources: ExternalSource[];
}

type Verdict =
  | { kind: 'recommendation'; text: string; restsOn: string[] }
  | { kind: 'withheld'; reason: string; missing: string }
  | { kind: 'conflict'; reason: string; conflicts: Finding[] };

interface BriefResponse {
  question: string;
  verdict: Verdict;
  findings: Finding[];
  openQuestions: string[];
  rejected: Array<{ claim: string; reason: string }>;
  evidence: { internalSources: number; externalPublishers: number };
  gathered: { internalFacts: number; externalFindings: number; researchStopReason: string | null };
  elapsedMs: number;
  error?: string;
}

/** Questions that need both halves. Each one is useless with only one side. */
const EXAMPLES = [
  'Is our booking amount to hold a flat competitive for Thane?',
  'Is our 7-day refund window normal for this market?',
  'Are our site visit timings in line with other brokers?',
];

const BASIS_META: Record<Basis, { label: string; cls: string; Icon: typeof Scale }> = {
  conflict: {
    label: 'DISAGREEMENT',
    cls: 'bg-amber-500/10 text-amber-800 border-amber-500/30',
    Icon: AlertTriangle,
  },
  both: {
    label: 'YOUR RECORDS + MARKET',
    cls: 'bg-emerald-500/10 text-emerald-800 border-emerald-500/30',
    Icon: CheckCircle2,
  },
  internal: {
    label: 'YOUR RECORDS ONLY',
    cls: 'bg-sky-500/10 text-sky-800 border-sky-500/30',
    Icon: Building2,
  },
  external: {
    label: 'MARKET ONLY',
    cls: 'bg-slate-500/10 text-slate-700 border-slate-400/30',
    Icon: Globe,
  },
};

/** Conflicts first, then corroborated, then each one-sided view. */
const BASIS_ORDER: Basis[] = ['conflict', 'both', 'internal', 'external'];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export default function DecidePage() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(q: string) {
    const asked = q.trim();
    if (!asked || loading) return;
    setLoading(true);
    setError(null);
    setBrief(null);
    try {
      const res = await fetch('/api/decision-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: asked }),
      });
      const data = (await res.json()) as BriefResponse;
      if (!res.ok) {
        setError(data.error || `Request failed (${res.status}).`);
      } else {
        setBrief(data);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'The brief could not be produced.');
    } finally {
      setLoading(false);
    }
  }

  const v = brief?.verdict;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">Decide</h1>
          <p className="text-slate-500 text-sm mt-1 max-w-2xl">
            Ask a question that needs both your own records and the outside market.
            When the two disagree, you get both figures and no recommendation —
            averaging them would produce a number neither source supports.
          </p>
        </div>
        <div className="flex items-center space-x-2 px-3 py-1.5 bg-emerald-500/10 text-emerald-700 rounded-full border border-emerald-500/20 text-xs font-bold">
          <Scale className="w-4 h-4 text-emerald-600" />
          <span>Both sides, or nothing</span>
        </div>
      </div>

      {/* ── Ask ─────────────────────────────────────────────────────────── */}
      <div className="bg-white border border-cream-300 rounded-2xl p-5 space-y-3">
        <label htmlFor="brief-q" className="block text-[11px] font-bold uppercase tracking-wider text-slate-500">
          Your question
        </label>
        <div className="flex gap-2 flex-wrap sm:flex-nowrap">
          <input
            id="brief-q"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(question); }}
            placeholder="Is our booking amount competitive for Thane?"
            maxLength={500}
            className="flex-1 min-w-0 px-4 py-2.5 border border-cream-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
          />
          <button
            type="button"
            onClick={() => run(question)}
            disabled={loading || !question.trim()}
            className="px-5 py-2.5 rounded-xl text-sm font-bold bg-heading text-white disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />}
            {loading ? 'Reading both sides…' : 'Build brief'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => { setQuestion(ex); run(ex); }}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-full border border-cream-300 text-slate-600 hover:bg-cream-100 disabled:opacity-40"
            >
              {ex}
            </button>
          ))}
        </div>
        {loading && (
          <p className="text-xs text-slate-500" role="status">
            Reading this workspace&apos;s records, then searching outside sources.
            Usually under a minute.
          </p>
        )}
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-2xl p-4 text-sm text-rose-800">
          {error}
        </div>
      )}

      {/* ── The verdict, first and largest ──────────────────────────────── */}
      {brief && v && (
        <div className="space-y-5">
          <div
            className={`rounded-2xl p-5 border ${
              v.kind === 'recommendation'
                ? 'bg-emerald-500/10 border-emerald-500/30'
                : v.kind === 'conflict'
                  ? 'bg-amber-500/10 border-amber-500/30'
                  : 'bg-slate-500/10 border-slate-400/30'
            }`}
          >
            <div className="flex items-start gap-3">
              {v.kind === 'recommendation' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-700 mt-0.5 shrink-0" />
              ) : v.kind === 'conflict' ? (
                <AlertTriangle className="w-5 h-5 text-amber-700 mt-0.5 shrink-0" />
              ) : (
                <MinusCircle className="w-5 h-5 text-slate-600 mt-0.5 shrink-0" />
              )}
              <div className="space-y-1">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                  {v.kind === 'recommendation'
                    ? 'Answer'
                    : v.kind === 'conflict'
                      ? 'No single answer'
                      : 'No recommendation'}
                </p>
                <p className="text-sm text-slate-800 leading-relaxed">
                  {v.kind === 'recommendation' ? v.text : v.reason}
                </p>
              </div>
            </div>
          </div>

          <p className="text-sm text-slate-600 font-serif italic">{brief.question}</p>

          {/* ── Findings, grouped by where the evidence came from ────────── */}
          {BASIS_ORDER.map((basis) => {
            const group = brief.findings.filter((f) => f.basis === basis);
            if (group.length === 0) return null;
            const meta = BASIS_META[basis];
            return (
              <div key={basis} className="space-y-3">
                {group.map((f, i) => (
                  <div key={`${basis}-${i}`} className="bg-white border border-cream-300 rounded-2xl p-4 space-y-2">
                    <span
                      className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full border ${meta.cls}`}
                    >
                      <meta.Icon className="w-3 h-3" />
                      {meta.label}
                    </span>
                    <p className="text-sm text-slate-800 font-medium leading-relaxed">{f.claim}</p>
                    <p className="text-xs text-slate-500 leading-relaxed">{f.caveat}</p>
                    {(f.internalSources.length > 0 || f.externalSources.length > 0) && (
                      <ul className="pt-1 space-y-1">
                        {f.internalSources.map((s) => (
                          <li key={s} className="text-xs text-sky-800 inline-flex items-center gap-1.5">
                            <Building2 className="w-3 h-3 shrink-0" />
                            your records: {s}
                          </li>
                        ))}
                        {f.externalSources.map((s) => (
                          <li key={s.url}>
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-slate-600 hover:text-heading inline-flex items-center gap-1.5"
                            >
                              <ExternalLink className="w-3 h-3 shrink-0" />
                              {s.title?.trim() || hostOf(s.url)}
                              <span className="text-slate-400">· {hostOf(s.url)}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            );
          })}

          {/* ── What neither side could establish ───────────────────────── */}
          {brief.openQuestions.length > 0 && (
            <div className="bg-cream-100 border border-cream-300 rounded-2xl p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Could not be established by either side
              </p>
              <ul className="mt-2 space-y-1.5">
                {brief.openQuestions.map((q) => (
                  <li key={q} className="text-sm text-slate-700">— {q}</li>
                ))}
              </ul>
              <p className="text-xs text-slate-500 mt-3">
                Gaps are shown because in a market scan they are often more
                decision-relevant than the findings.
              </p>
            </div>
          )}

          {/* ── Dropped claims, never silently ─────────────────────────── */}
          {brief.rejected.length > 0 && (
            <details className="bg-white border border-cream-300 rounded-2xl p-4">
              <summary className="text-[11px] font-bold uppercase tracking-wider text-slate-500 cursor-pointer">
                Dropped for lacking a source ({brief.rejected.length})
              </summary>
              <ul className="mt-2 space-y-1.5">
                {brief.rejected.map((r, i) => (
                  <li key={i} className="text-sm text-slate-600">
                    {r.claim} <span className="text-slate-400">— {r.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* ── The evidence base, counted rather than claimed ──────────── */}
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-slate-500 border-t border-cream-300 pt-4">
            <span>
              <strong className="text-slate-700">{brief.evidence.internalSources}</strong> record(s) from this workspace
            </span>
            <span>
              <strong className="text-slate-700">{brief.evidence.externalPublishers}</strong> outside publisher(s)
            </span>
            <span>
              <strong className="text-slate-700">{(brief.elapsedMs / 1000).toFixed(1)}s</strong>
            </span>
            {brief.gathered.researchStopReason && (
              <span>research stopped: {brief.gathered.researchStopReason}</span>
            )}
          </div>
        </div>
      )}

      {!brief && !loading && !error && (
        <div className="bg-white border border-cream-300 rounded-2xl p-6">
          <p className="text-sm text-slate-600 leading-relaxed max-w-2xl">
            Nothing is shown until you ask. This page holds no cached answer,
            because a brief is only as good as the records and sources read at the
            moment it was built — and both change.
          </p>
        </div>
      )}
    </div>
  );
}
