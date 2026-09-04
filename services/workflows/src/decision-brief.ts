/**
 * WHAT A BUSINESS OWNER ACTUALLY ASKS, AND WHY THE RESEARCH ALONE CANNOT ANSWER IT.
 *
 * `market-research.ts` and `deep-research.ts` answer outward-facing questions
 * well: what are Thane stamp duty rates, what does MahaRERA charge an agent.
 * Cited, tiered by corroboration, honest about what it could not establish.
 *
 * But an owner does not ask "what are stamp duty rates". They ask:
 *
 *   "Should I raise my booking amount?"
 *   "Am I losing buyers on price or on response time?"
 *   "Is my aftercare policy competitive?"
 *
 * Every one of those needs BOTH sides. The market alone cannot say whether YOUR
 * booking amount is wrong; your own numbers alone cannot say whether they are
 * unusual. An answer built from one side, presented as a recommendation, is the
 * confident-sounding advice that gets a business into trouble.
 *
 * ── THE RULE THAT MAKES THIS WORTH SHIPPING ─────────────────────────────────
 *
 * WHEN THE TWO SIDES DISAGREE, SAY SO. DO NOT AVERAGE THEM.
 *
 * A model handed "market says 2% is typical" and "your data says you charge 5%"
 * will happily produce a smooth paragraph recommending 3.5%. That number is
 * supported by nothing. It is the single most dangerous output an advisory tool
 * can produce, because it reads exactly like the well-supported ones.
 *
 * So a conflict is a FINDING, not an input to be resolved. It is surfaced with
 * both figures and both sources, and the recommendation is withheld.
 *
 * ── AND THE RULE THAT KEEPS IT HONEST ───────────────────────────────────────
 *
 * NO RECOMMENDATION FROM ONE SIDE ONLY.
 *
 * If the business has no data on a question, the brief says the market view and
 * explicitly declines to recommend. If the market gave nothing, the same in
 * reverse. This is why `basis` is on every finding: a reader can tell at a
 * glance which claims rest on their own books and which on somebody's blog.
 *
 * PURE ON PURPOSE — no clock, no I/O, no model. The gathering happens in the
 * activity; everything here is a function of its inputs so it can be tested
 * exhaustively, which is the only way rules like the two above stay true.
 */

import type { ResearchFinding, ResearchReport, ResearchSource } from './market-research.js';

/** Where a claim's evidence comes from. The most important field here. */
export type EvidenceBasis =
  /** This workspace's own records: conversations, documents, listings, metrics. */
  | 'internal'
  /** The outside world: web sources, cited. */
  | 'external'
  /** Both sides, agreeing. The only basis a recommendation may rest on. */
  | 'both'
  /** Both sides, DISAGREEING. Never resolved, never averaged. */
  | 'conflict';

/** One thing the business knows about itself. */
export interface InternalFact {
  /** The claim, one sentence. */
  claim: string;
  /**
   * Where in the workspace it came from — a document title, "conversations",
   * a metric id. Never a guess: an internal fact with no provenance is dropped
   * by `buildDecisionBrief`, for the same reason a research finding without a
   * source is.
   */
  source: string;
  /** Optional number, when the claim is quantitative. Enables conflict detection. */
  value?: number;
  /** What `value` is measured in, e.g. 'INR', 'percent', 'hours'. */
  unit?: string;
  /** Optional subject the claim is about, used to pair internal with external. */
  subject?: string;
}

export interface BriefFinding {
  claim: string;
  basis: EvidenceBasis;
  /** Confidence carried over from research, or 'internal_record' for own data. */
  confidence: string;
  /** One plain sentence a non-technical reader can act on. */
  caveat: string;
  internalSources: string[];
  externalSources: ResearchSource[];
}

export interface DecisionBrief {
  question: string;
  /**
   * The answer, or the reason there is not one. Never a hedge: either a
   * recommendation resting on 'both', or an explicit refusal naming what is
   * missing.
   */
  verdict:
    | { kind: 'recommendation'; text: string; restsOn: string[] }
    | { kind: 'withheld'; reason: string; missing: 'internal' | 'external' | 'both' }
    | { kind: 'conflict'; reason: string; conflicts: BriefFinding[] };
  findings: BriefFinding[];
  /** Claims dropped, with why. Never silently discarded. */
  rejected: Array<{ claim: string; reason: string }>;
  /** What neither side could establish. Often the most decision-relevant part. */
  openQuestions: string[];
  internalSourceCount: number;
  externalDomainCount: number;
}

/** A quantitative claim needs a subject and a number to be comparable. */
function comparable(f: { value?: number; subject?: string }): boolean {
  return typeof f.value === 'number' && Number.isFinite(f.value)
    && typeof f.subject === 'string' && f.subject.trim().length > 0;
}

function normSubject(s: string | undefined): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Do two numbers on the same subject disagree enough to matter?
 *
 * A relative threshold, not absolute: 5% apart on a booking amount is noise,
 * 5% apart on a commission rate is the whole margin. Callers that know better
 * can pass their own tolerance.
 *
 * Both zero is agreement, not a division by zero.
 */
export function materiallyDiffers(a: number, b: number, tolerance = 0.15): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === b) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return false;
  return Math.abs(a - b) / scale > tolerance;
}

/**
 * Pull a number and its subject out of a research finding, when it has one.
 *
 * Deliberately narrow: it reads `value`/`unit`/`subject` only when the caller
 * supplied them. It does NOT parse figures out of prose. A regex that finds
 * "7%" in a sentence cannot tell whether that is the rate for this buyer, last
 * year's rate, or a competitor's — and a wrong pairing produces a fabricated
 * conflict, which is worse than a missed one.
 */
function externalNumber(f: ResearchFinding & { value?: number; subject?: string }):
{ value: number; subject: string } | null {
  return comparable(f) ? { value: f.value as number, subject: f.subject as string } : null;
}

export interface BuildBriefInput {
  question: string;
  internal: InternalFact[];
  research: ResearchReport | null;
  /** Fractional tolerance before two numbers count as disagreeing. */
  tolerance?: number;
}

/**
 * Merge what the business knows with what the world says.
 *
 * The order of the checks is the whole design:
 *   1. drop anything without provenance
 *   2. pair internal and external claims on the same subject
 *   3. a disagreeing pair becomes a CONFLICT finding and blocks the verdict
 *   4. an agreeing pair becomes BOTH — the only basis a recommendation may use
 *   5. everything unpaired stays internal-only or external-only, and is
 *      reported as such rather than promoted
 */
export function buildDecisionBrief(input: BuildBriefInput): DecisionBrief {
  const question = String(input.question || '').trim();
  const tolerance = typeof input.tolerance === 'number' ? input.tolerance : 0.15;
  const rejected: Array<{ claim: string; reason: string }> = [
    ...((input.research?.rejected) || []),
  ];

  // ── 1. Provenance or nothing ──────────────────────────────────────────────
  const internal: InternalFact[] = [];
  for (const f of input.internal || []) {
    const claim = String(f?.claim || '').trim();
    const source = String(f?.source || '').trim();
    if (!claim) continue;
    if (!source) {
      // Same standard research findings are held to. A fact about the business
      // with no record behind it is somebody's recollection.
      rejected.push({ claim, reason: 'no source in this workspace — internal facts must cite a record' });
      continue;
    }
    internal.push({ ...f, claim, source });
  }

  const external = (input.research?.findings || []).filter((f) => (f.sources || []).length > 0);

  // ── 2 & 3 & 4. Pair on subject, detect conflict ───────────────────────────
  const findings: BriefFinding[] = [];
  const conflicts: BriefFinding[] = [];
  const pairedExternal = new Set<ResearchFinding>();
  const pairedInternal = new Set<InternalFact>();

  for (const int of internal) {
    if (!comparable(int)) continue;
    const subj = normSubject(int.subject);
    for (const ext of external) {
      if (pairedExternal.has(ext)) continue;
      const extNum = externalNumber(ext as ResearchFinding & { value?: number; subject?: string });
      if (!extNum || normSubject(extNum.subject) !== subj) continue;

      pairedExternal.add(ext);
      pairedInternal.add(int);

      const differs = materiallyDiffers(int.value as number, extNum.value, tolerance);
      const finding: BriefFinding = {
        claim: differs
          ? `${int.subject}: your records say ${int.value}${int.unit ? ' ' + int.unit : ''}, `
            + `the market says ${extNum.value}${int.unit ? ' ' + int.unit : ''}.`
          : `${int.subject}: your records and the market agree at about `
            + `${int.value}${int.unit ? ' ' + int.unit : ''}.`,
        basis: differs ? 'conflict' : 'both',
        confidence: differs ? 'disagreement' : ext.confidence,
        caveat: differs
          ? 'Both figures are shown because they disagree. No single number is '
            + 'recommended here — averaging them would produce a figure neither '
            + 'source supports.'
          : 'Supported by this workspace\'s own records and by outside sources.',
        internalSources: [int.source],
        externalSources: ext.sources,
      };
      findings.push(finding);
      if (differs) conflicts.push(finding);
      break;
    }
  }

  // ── 5. Unpaired: reported as one-sided, never promoted ────────────────────
  for (const int of internal) {
    if (pairedInternal.has(int)) continue;
    findings.push({
      claim: int.claim,
      basis: 'internal',
      confidence: 'internal_record',
      caveat: `From this workspace only (${int.source}). Not checked against the market.`,
      internalSources: [int.source],
      externalSources: [],
    });
  }
  for (const ext of external) {
    if (pairedExternal.has(ext)) continue;
    findings.push({
      claim: ext.claim,
      basis: 'external',
      confidence: ext.confidence,
      caveat: `${ext.caveat} This workspace holds no figure of its own to compare.`,
      internalSources: [],
      externalSources: ext.sources,
    });
  }

  // ── The verdict ───────────────────────────────────────────────────────────
  const hasInternal = findings.some((f) => f.basis === 'internal' || f.basis === 'both' || f.basis === 'conflict');
  const hasExternal = findings.some((f) => f.basis === 'external' || f.basis === 'both' || f.basis === 'conflict');
  const corroborated = findings.filter((f) => f.basis === 'both');

  let verdict: DecisionBrief['verdict'];
  if (conflicts.length > 0) {
    // Conflict outranks everything. A brief that recommended around a known
    // disagreement would be hiding the one thing the owner most needs to see.
    verdict = {
      kind: 'conflict',
      reason: `Your own records and the outside sources disagree on `
        + `${conflicts.length === 1 ? 'one point' : `${conflicts.length} points`}. `
        + 'Both figures are given below. Deciding this needs a person, because '
        + 'the difference may be your pricing power rather than an error.',
      conflicts,
    };
  } else if (!hasInternal && !hasExternal) {
    verdict = { kind: 'withheld', reason: 'Nothing was found on either side.', missing: 'both' };
  } else if (!hasInternal) {
    verdict = {
      kind: 'withheld',
      missing: 'internal',
      reason: 'The market view is below, but this workspace holds no data of its '
        + 'own on the question, so no recommendation is made. Upload the relevant '
        + 'policy or records and ask again.',
    };
  } else if (!hasExternal) {
    verdict = {
      kind: 'withheld',
      missing: 'external',
      reason: 'Your own records are below, but nothing was retrieved from outside '
        + 'to compare them against, so no recommendation is made about whether '
        + 'they are competitive.',
    };
  } else if (corroborated.length === 0) {
    verdict = {
      kind: 'withheld',
      missing: 'both',
      reason: 'Both sides returned findings, but none of them are about the same '
        + 'measurable thing, so nothing is directly comparable. The two views are '
        + 'below, kept apart on purpose.',
    };
  } else {
    verdict = {
      kind: 'recommendation',
      text: `On the points where your records and the market can be compared, they `
        + `agree (${corroborated.length}). Proceeding on that basis is supported by `
        + 'evidence from both sides.',
      restsOn: corroborated.map((f) => f.claim),
    };
  }

  const internalSourceCount = new Set(
    findings.flatMap((f) => f.internalSources)
  ).size;
  const externalDomainCount = new Set(
    findings.flatMap((f) => f.externalSources.map((s) => String(s.url || '')))
      .map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } })
      .filter(Boolean)
  ).size;

  return {
    question,
    verdict,
    findings,
    rejected,
    openQuestions: [...(input.research?.openQuestions || [])],
    internalSourceCount,
    externalDomainCount,
  };
}

const BASIS_LABEL: Record<EvidenceBasis, string> = {
  both: 'YOUR RECORDS + MARKET',
  conflict: 'DISAGREEMENT',
  internal: 'YOUR RECORDS ONLY',
  external: 'MARKET ONLY',
};

/**
 * The brief as an owner reads it.
 *
 * The verdict goes FIRST, including when it is a refusal. A reader who stops
 * after one paragraph must not come away with a recommendation the evidence
 * does not support, and people do stop after one paragraph.
 */
export function renderDecisionBrief(brief: DecisionBrief): string {
  const out: string[] = [];

  if (brief.verdict.kind === 'recommendation') {
    out.push(`ANSWER — ${brief.verdict.text}`);
  } else if (brief.verdict.kind === 'conflict') {
    out.push(`NO SINGLE ANSWER — ${brief.verdict.reason}`);
  } else {
    out.push(`NO RECOMMENDATION — ${brief.verdict.reason}`);
  }
  out.push('');
  out.push(brief.question);
  out.push('');

  // Conflicts first, then corroborated, then the one-sided views.
  const order: EvidenceBasis[] = ['conflict', 'both', 'internal', 'external'];
  for (const basis of order) {
    for (const f of brief.findings.filter((x) => x.basis === basis)) {
      out.push(`[${BASIS_LABEL[basis]}] ${f.claim}`);
      out.push(`  ${f.caveat}`);
      for (const s of f.internalSources) out.push(`  - your records: ${s}`);
      for (const s of f.externalSources) out.push(`  - ${s.title || s.url} — ${s.url}`);
      out.push('');
    }
  }

  if (brief.openQuestions.length > 0) {
    out.push('Could not be established by either side:');
    for (const q of brief.openQuestions) out.push(`  - ${q}`);
    out.push('');
  }

  if (brief.rejected.length > 0) {
    out.push(`Dropped for lacking a source (${brief.rejected.length}):`);
    for (const r of brief.rejected.slice(0, 5)) out.push(`  - ${r.claim} — ${r.reason}`);
    out.push('');
  }

  out.push(
    `Evidence base: ${brief.internalSourceCount} record(s) from this workspace, `
    + `${brief.externalDomainCount} outside publisher(s).`
  );

  return out.join('\n').trim();
}
