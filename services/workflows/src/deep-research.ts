/**
 * Deep research — the difference between one search and actually looking into
 * something.
 *
 * A single search answers "what does the first page of results say". That is
 * enough for "what is the stamp duty rate" and useless for every question an
 * owner actually pays for: is this locality's pricing holding up, what are the
 * three competitors doing, is this regulation about to change. Those need what
 * a person does — search, read, notice what is still missing, search again for
 * the missing part, and only then write it up.
 *
 * This module is the planning half of that loop, kept pure so it can be tested
 * without the network. The I/O half lives in `activities/deep-research.ts`.
 *
 * ── WHY THE LOOP IS BOUNDED AND EXPLICIT ────────────────────────────────────
 *
 * An unbounded "keep researching until satisfied" loop has two failure modes,
 * and both bite in production rather than in testing:
 *
 *   1. It never stops. Every round produces a new open question, because there
 *      is always another question. Cost grows without a ceiling and the caller
 *      has no way to predict a bill.
 *   2. It stops for the wrong reason and reports as though it had finished.
 *      A round that returned nothing looks like a round that found everything.
 *
 * So a run has a fixed maximum number of rounds, and it records WHY it stopped
 * — `answered`, `exhausted`, `budget`, or `no-progress`. A report whose stop
 * reason is `budget` is a partial answer and must be read as one; the caller is
 * told, never left to infer it from a short findings list.
 *
 * ── AND WHY IT REFUSES TO GUESS THE NEXT QUERY FROM NOTHING ─────────────────
 *
 * Follow-up queries come from the open questions the synthesis step actually
 * produced, not from permuting the topic with words like "latest" and "2026".
 * Query permutation feels like depth and returns the same page four times,
 * which then reads as four-way corroboration — the exact confidence inflation
 * `market-research.ts` was written to prevent.
 */

export type StopReason = 'answered' | 'exhausted' | 'no-progress' | 'budget';

export interface ResearchRound {
  round: number;
  /** Queries issued this round. */
  queries: string[];
  /** URLs whose text was actually retrieved this round. */
  urlsRead: string[];
  /** New distinct publishers this round added. Zero means no progress. */
  newDomains: number;
  /** Questions the synthesis step could not answer from what it had. */
  openQuestions: string[];
}

export interface DeepResearchPlan {
  /** Queries to issue this round. Never empty when `done` is false. */
  queries: string[];
  done: boolean;
  stopReason?: StopReason;
}

/** Hard ceiling on rounds, regardless of what the caller asks for. */
export const MAX_ROUNDS = 4;

/**
 * A follow-up query built from an open question.
 *
 * The topic is carried along because open questions are written elliptically —
 * "whether the freeze applies to commercial units" is not a searchable string
 * on its own, and searching it alone returns freezes of unrelated things.
 */
export function followUpQuery(topic: string, openQuestion: string): string {
  const q = String(openQuestion || '').trim().replace(/^(?:whether|if|what|how|does|do|is|are)\s+/i, '');
  const t = String(topic || '').trim();
  if (!q) return t;
  // Drop topic words already present, so the query does not repeat itself.
  const have = new Set(q.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const add = (t.match(/[A-Za-z0-9]{4,}/g) || []).filter((w) => !have.has(w.toLowerCase()));
  return add.length ? `${q} ${add.join(' ')}`.trim() : q;
}

/**
 * What to do next, given everything that has happened so far.
 *
 * Pure. Takes the history and returns the next queries or a stop reason, so
 * every stopping rule below is testable without spending a token.
 */
export function planNextRound(
  topic: string,
  history: ResearchRound[],
  opts: { maxRounds?: number; minDomains?: number } = {}
): DeepResearchPlan {
  const maxRounds = Math.min(Math.max(1, opts.maxRounds ?? MAX_ROUNDS), MAX_ROUNDS);
  const minDomains = Math.max(1, opts.minDomains ?? 3);

  // First round: the topic itself, nothing invented around it.
  if (history.length === 0) {
    return { queries: [String(topic || '').trim()].filter(Boolean), done: false };
  }

  const last = history[history.length - 1];
  const totalDomains = history.reduce((n, r) => n + r.newDomains, 0);

  if (history.length >= maxRounds) {
    return { queries: [], done: true, stopReason: 'budget' };
  }

  // Nothing left to ask. Only "answered" if we actually saw enough publishers —
  // an empty open-questions list from a run that found two pages is a model
  // being incurious, not a question being settled.
  if (last.openQuestions.length === 0) {
    return {
      queries: [],
      done: true,
      stopReason: totalDomains >= minDomains ? 'answered' : 'exhausted',
    };
  }

  // A round that added no new publisher will not do better with more of the
  // same queries. Stop rather than burn the remaining rounds re-reading one site.
  if (last.newDomains === 0) {
    return { queries: [], done: true, stopReason: 'no-progress' };
  }

  const asked = new Set(history.flatMap((r) => r.queries).map((q) => q.toLowerCase().trim()));
  const queries = last.openQuestions
    .slice(0, 3)
    .map((q) => followUpQuery(topic, q))
    .filter((q) => q && !asked.has(q.toLowerCase().trim()));

  // Every follow-up was already asked. More rounds cannot help.
  if (queries.length === 0) {
    return { queries: [], done: true, stopReason: 'exhausted' };
  }

  return { queries, done: false };
}

/**
 * The sentence that goes at the top of a report, saying how far the research
 * actually got.
 *
 * Written out rather than left to the caller because the stop reason is the
 * single most misreadable part of a research report: a confident-looking set of
 * findings that stopped at the round limit is a partial answer, and nothing in
 * the findings themselves says so.
 */
export function stopNotice(reason: StopReason, rounds: number, domains: number): string {
  const scope = `${rounds} round${rounds === 1 ? '' : 's'}, ${domains} independent source${domains === 1 ? '' : 's'}`;
  switch (reason) {
    case 'answered':
      return `Researched over ${scope}. No open questions remained.`;
    case 'budget':
      return `PARTIAL — stopped at the round limit after ${scope}. Open questions below were not pursued.`;
    case 'no-progress':
      return `PARTIAL — stopped after ${scope} because a further round found no new publisher. Treat gaps as unresearched, not as absent.`;
    case 'exhausted':
      return `Stopped after ${scope}: no further question could be turned into a new search. Evidence base is thin — read the findings with that in mind.`;
    default:
      return `Researched over ${scope}.`;
  }
}
