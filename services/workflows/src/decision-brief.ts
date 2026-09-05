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
  /**
   * Which half could not be read, if either. Distinct from that half being
   * empty — see `BuildBriefInput.degraded`.
   */
  unavailable?: { internal?: string; external?: string };
  /**
   * How old the workspace records behind this brief are. Undefined when the
   * caller did not supply dates — absent, never guessed.
   */
  freshness?: BriefFreshness;
}

/**
 * HOW OLD IS THE EVIDENCE? THE QUESTION NOBODY ASKS UNTIL IT HAS COST THEM.
 *
 * A brief puts the business's own records beside today's market data and
 * compares them as peers. That is only fair if they are contemporaneous. A
 * price list uploaded eighteen months ago, compared against a figure scraped
 * this morning, produces a confident "you are 30% under market" that is really
 * just the passage of time — and it reads exactly like insight.
 *
 * The retrieval layer already computes this and always has: every memory query
 * selects `updated_at` and a `stale` flag. Nothing carried it as far as the
 * reader, so the one number that tells an owner whether to trust the comparison
 * was computed, discarded, and then implicitly denied by presenting old records
 * with no date at all.
 *
 * Reported rather than enforced. A stale record is not wrong - a refund policy
 * from two years ago may be perfectly current - so this never suppresses a
 * finding. It states the age and lets the person who knows the business decide,
 * which is the only division of labour that makes a brief trustworthy.
 */
export interface BriefFreshness {
  /** ISO date of the most recently updated record used. */
  newest?: string;
  /** ISO date of the oldest. */
  oldest?: string;
  /** How many of the records used were flagged stale by retrieval. */
  stale: number;
  /** How many records were used in total. */
  total: number;
  /** One plain sentence for the reader. */
  note: string;
}

/**
 * COMPARING TWO NUMBERS WITHOUT CHECKING THEIR UNITS IS HOW A BRIEF LIES.
 *
 * `comparable()` required a value and a subject and never looked at the unit,
 * so an internal "2 percent" and an external "150000 INR" about the same
 * subject were run through `materiallyDiffers` as bare numbers. They differ, so
 * the brief reported a conflict. Worse, the claim line rendered the EXTERNAL
 * number using the INTERNAL unit:
 *
 *   `${extNum.value}${int.unit ? ' ' + int.unit : ''}`
 *
 * which prints "your records say 2 percent, the market says 150000 percent" -
 * a number nobody wrote, in a unit nobody used, presented to an owner as a
 * disagreement to act on. A brief that invents a conflict is worse than one
 * that misses it, which is the principle `externalNumber` already states.
 *
 * This matters more here than it would elsewhere, because the market this
 * serves writes money three ways. 51000, 0.51 lakh and 0.0051 crore are the
 * same amount, and a unit-blind comparison calls two of them a 100x error.
 * Scale words are therefore converted to a base unit rather than rejected -
 * `sameUnit` accepts them and `toBase` reconciles them, so "Rs 51,000" and
 * "0.51 lakh" correctly AGREE.
 */
const UNIT_ALIASES: Record<string, string> = {
  // Currency. Rupee symbol and the many ways people type it.
  'inr': 'inr', 'rs': 'inr', 'rs.': 'inr', 'r': 'inr', 'rupee': 'inr', 'rupees': 'inr',
  '\u20b9': 'inr', 'inr.': 'inr',
  'usd': 'usd', 'dollar': 'usd', 'dollars': 'usd', '$': 'usd',
  'eur': 'eur', 'euro': 'eur', 'euros': 'eur', '\u20ac': 'eur',
  // Proportion.
  'percent': 'percent', 'percentage': 'percent', 'pct': 'percent', '%': 'percent',
  'per cent': 'percent', 'bps': 'bps',
  // Time.
  'day': 'days', 'days': 'days', 'week': 'weeks', 'weeks': 'weeks',
  'month': 'months', 'months': 'months', 'year': 'years', 'years': 'years',
  'hour': 'hours', 'hours': 'hours', 'hr': 'hours', 'hrs': 'hours',
  'minute': 'minutes', 'minutes': 'minutes', 'min': 'minutes', 'mins': 'minutes',
  // Area, for property and furniture.
  'sqft': 'sqft', 'sq ft': 'sqft', 'sq.ft': 'sqft', 'sq. ft.': 'sqft',
  'square feet': 'sqft', 'square foot': 'sqft', 'sft': 'sqft',
  'sqm': 'sqm', 'sq m': 'sqm', 'square metre': 'sqm', 'square meter': 'sqm',
};

/** Indian scale words, expressed as a multiplier onto the base currency. */
const SCALE_WORDS: Record<string, number> = {
  'lakh': 1e5, 'lakhs': 1e5, 'lac': 1e5, 'lacs': 1e5,
  'crore': 1e7, 'crores': 1e7, 'cr': 1e7,
  'thousand': 1e3, 'k': 1e3, 'million': 1e6, 'mn': 1e6, 'm': 1e6,
  'billion': 1e9, 'bn': 1e9,
};

/**
 * Reduce a written unit to a canonical unit plus a multiplier to its base.
 *
 * "lakh" alone carries no currency, so it canonicalises to INR: in this market
 * an unqualified lakh is rupees. "USD million" keeps usd and multiplies by 1e6.
 */
export function canonicalUnit(raw?: string): { unit: string | null; scale: number } {
  const text = String(raw || '').trim().toLowerCase().replace(/[()]/g, ' ').trim();
  if (!text) return { unit: null, scale: 1 };

  const direct = UNIT_ALIASES[text];
  if (direct) return { unit: direct, scale: 1 };

  let scale = 1;
  let unit: string | null = null;
  for (const word of text.split(/[\s/]+/).filter(Boolean)) {
    const cleaned = word.replace(/[.,]$/, '');
    if (SCALE_WORDS[cleaned] !== undefined) {
      scale *= SCALE_WORDS[cleaned];
      continue;
    }
    const mapped = UNIT_ALIASES[cleaned];
    if (mapped && !unit) unit = mapped;
  }
  // A bare scale word in this market means rupees.
  if (!unit && scale !== 1) unit = 'inr';
  // Unrecognised but present: keep it normalised so two identical spellings
  // still compare equal, rather than silently becoming "no unit".
  if (!unit) unit = text;
  return { unit, scale };
}

/**
 * May these two figures be compared at all?
 *
 * Blocks ONLY when both units are known and they differ. An unlabelled number
 * cannot prove a mismatch, so it is compared as before.
 *
 * The stricter rule - refuse whenever either side is unlabelled - was written
 * first and was wrong. Research findings usually carry no unit at all, so it
 * silently stopped comparing almost everything: three existing tests went from
 * 'conflict' and 'recommendation' to 'withheld', which is the brief quietly
 * abstaining on questions it could answer. Refusing to compare is not the safe
 * default it looks like; it just moves the failure somewhere less visible.
 *
 * The trade-off is stated rather than hidden: an unlabelled figure that really
 * was in another unit will still be compared. That is unchanged from before,
 * and the case actually causing harm - percent against INR, both labelled and
 * both ignored - is now caught.
 */
export function sameUnit(a?: string, b?: string): boolean {
  const ca = canonicalUnit(a);
  const cb = canonicalUnit(b);
  if (ca.unit === null || cb.unit === null) return true;
  return ca.unit === cb.unit;
}

/** The figure expressed in its canonical base, so lakh and rupees can meet. */
export function toBase(value: number, unit?: string): number {
  return value * canonicalUnit(unit).scale;
}

/** How a figure should be written back to the reader: its OWN unit, never the other side's. */
export function renderQuantity(value: number, unit?: string): string {
  const u = String(unit || '').trim();
  return u ? `${value} ${u}` : String(value);
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
 * Deliberately narrow: it reads the `subject`/`value` that `validateFindings`
 * already checked against the cited excerpt. It does NOT parse figures out of
 * prose here. A regex that finds "7%" in a sentence cannot tell whether that is
 * the rate for this buyer, last year's rate, or a competitor's — and a wrong
 * pairing produces a fabricated conflict, which is worse than a missed one.
 */
function externalNumber(f: ResearchFinding): { value: number; subject: string } | null {
  return comparable(f) ? { value: f.value as number, subject: f.subject as string } : null;
}

/**
 * Collapse the same fact retrieved from several places.
 *
 * Memory holds a fact once per row it appears in: an upload, the conversation
 * that quoted it, the write-back summary. Extraction faithfully returns all of
 * them, so one live brief listed the booking amount FOUR times:
 *
 *   The booking amount is fully refundable within 7 days...
 *   The booking amount to hold a flat is Rs 51,000, and it is fully refundable...
 *   The booking amount to hold a unit is Rs 51,000, fully refundable within...
 *   The booking amount to hold a flat is Rs 51,000.
 *
 * All true, all one fact. Repetition also reads as corroboration, which it is
 * not — the same document quoted three times is still one document.
 *
 * Keeps the LONGEST wording of each duplicate group, because that is the one
 * carrying the most detail, and merges the sources so provenance is not lost.
 * Matching is on the numeric claim signature when there is one, and on
 * normalised words otherwise. Deliberately conservative: two facts about the
 * same subject with DIFFERENT numbers are not duplicates, they are a genuine
 * inconsistency in the records and must both survive.
 */
export function dedupeInternalFacts(facts: InternalFact[]): InternalFact[] {
  const groups = new Map<string, InternalFact[]>();
  const order: string[] = [];

  for (const f of facts) {
    const words = String(f.claim || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    // A number in the claim makes the signature; same subject + same number is
    // the same fact however it is worded.
    const nums = words.match(/\d+/g);
    const key = typeof f.value === 'number' && f.subject
      ? `v:${normSubject(f.subject)}:${f.value}`
      : nums && nums.length > 0
        ? `n:${nums.sort().join('-')}`
        : `w:${words}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    (groups.get(key) as InternalFact[]).push(f);
  }

  const out: InternalFact[] = [];
  for (const key of order) {
    const group = groups.get(key) as InternalFact[];
    const best = group.reduce((a, b) => (String(b.claim).length > String(a.claim).length ? b : a));
    const sources = [...new Set(group.map((g) => g.source).filter(Boolean))];
    out.push({ ...best, source: sources.join(', ') });
  }
  return out;
}

export interface BuildBriefInput {
  /**
   * "WE FOUND NOTHING" AND "WE COULD NOT LOOK" ARE DIFFERENT SENTENCES.
   *
   * The caller wraps each half in a try/catch and, on failure, carried on with
   * an empty list:
   *
   *   } catch {
   *     internal = [];
   *   }
   *
   * So a database timeout produced a brief that told the owner "this workspace
   * holds no data of its own on the question". That is not a degraded answer,
   * it is a FALSE one — their records may be complete, and they were told their
   * business knows nothing about its own pricing. Then it advised them to
   * "upload the relevant records and ask again", which is work they did not need
   * to do, in response to an outage nobody mentioned.
   *
   * Naming the failed side lets the verdict say what actually happened. An
   * absent value means the side genuinely returned nothing, which is a real
   * finding and stays worded as one.
   */
  degraded?: { internal?: string; external?: string };
  /**
   * Ages of the workspace records this brief was built from, straight off the
   * retrieval rows. Optional: a caller that cannot supply real dates supplies
   * none, and the brief simply says nothing about freshness rather than
   * implying the records are current.
   */
  internalAsOf?: { newest?: string; oldest?: string; stale?: number; total?: number };
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

  // ── 1. Provenance or nothing, then collapse duplicates ────────────────────
  const kept: InternalFact[] = [];
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
    kept.push({ ...f, claim, source });
  }
  // Memory holds one fact once per row it appears in. Four copies of the
  // booking amount is not four pieces of evidence.
  const internal = dedupeInternalFacts(kept);

  const external = (input.research?.findings || []).filter((f) => (f.sources || []).length > 0);

  // ── 2 & 3 & 4. Pair on subject, detect conflict ───────────────────────────
  // Named once; both the verdict and the rendered output need them.
  const deadInternal = input.degraded?.internal;
  const deadExternal = input.degraded?.external;

  const findings: BriefFinding[] = [];
  const conflicts: BriefFinding[] = [];
  const pairedExternal = new Set<ResearchFinding>();
  const pairedInternal = new Set<InternalFact>();
  /** Same subject, units that cannot be reconciled. Surfaced, never resolved. */
  const unitMismatches: string[] = [];

  for (const int of internal) {
    if (!comparable(int)) continue;
    const subj = normSubject(int.subject);
    for (const ext of external) {
      if (pairedExternal.has(ext)) continue;
      const extNum = externalNumber(ext);
      if (!extNum || normSubject(extNum.subject) !== subj) continue;

      // Same subject, incompatible units. Not a conflict and not an agreement:
      // simply not a comparison. Both facts still reach the reader as one-sided
      // findings below, and the mismatch is raised as an open question rather
      // than being resolved by assumption.
      if (!sameUnit(int.unit, ext.unit)) {
        unitMismatches.push(
          `${int.subject}: your records are in ${int.unit || 'an unstated unit'} and the `
          + `outside figure is in ${ext.unit || 'an unstated unit'}. They were NOT compared. `
          + 'Confirm both are measuring the same thing before relying on either.'
        );
        continue;
      }

      pairedExternal.add(ext);
      pairedInternal.add(int);

      // Compared in a common base so 51000 INR and 0.51 lakh agree, but each
      // side is always PRINTED in the unit its own source used.
      const differs = materiallyDiffers(
        toBase(int.value as number, int.unit),
        toBase(extNum.value, ext.unit),
        tolerance
      );
      const finding: BriefFinding = {
        claim: differs
          ? `${int.subject}: your records say ${renderQuantity(int.value as number, int.unit)}, `
            + `the market says ${renderQuantity(extNum.value, ext.unit)}.`
          : `${int.subject}: your records and the market agree at about `
            + `${renderQuantity(int.value as number, int.unit)}.`,
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

  /**
   * Internal-versus-internal, before the one-sided pass below.
   *
   * Ordered first deliberately: a fact that contradicts another of the
   * workspace's own records must not also be reported as a plain one-sided
   * finding, or the same number appears twice in one brief with two different
   * meanings.
   */
  const internalConflicts = detectInternalConflicts(internal, tolerance);
  for (const c of internalConflicts) {
    findings.push(c);
    conflicts.push(c);
  }
  const inInternalConflict = new Set<string>();
  for (const c of internalConflicts) for (const src of c.internalSources) inInternalConflict.add(src);

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
    verdict = {
      kind: 'withheld',
      missing: 'both',
      reason: (deadInternal || deadExternal)
        ? `Neither side could be read: ${[deadInternal, deadExternal].filter(Boolean).join('; ')}. `
          + 'This is not a finding about your business — nothing was searched. Retry, and '
          + 'if it persists the records are fine and the service is not.'
        : 'Nothing was found on either side.',
    };
  } else if (!hasInternal) {
    verdict = {
      kind: 'withheld',
      missing: 'internal',
      // Never tell an owner their records are empty when we simply could not
      // open them, and never send them off to upload data they already have.
      reason: deadInternal
        ? `The market view is below. Your own records could NOT BE READ (${deadInternal}), `
          + 'so no recommendation is made. This says nothing about what your records '
          + 'contain — they were never searched. Retry before acting on the market half alone.'
        : 'The market view is below, but this workspace holds no data of its '
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
    // A unit mismatch is a decision-relevant unknown, not a footnote: it is
    // exactly the kind of thing that looks like an answer until someone acts
    // on it. Listed with what research could not establish.
    openQuestions: [...(input.research?.openQuestions || []), ...unitMismatches],
    freshness: buildFreshness(input.internalAsOf),
    unavailable: (deadInternal || deadExternal)
      ? { internal: deadInternal, external: deadExternal }
      : undefined,
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
/**
 * A BUSINESS'S OWN RECORDS CONTRADICTING EACH OTHER IS THE COMMONEST CASE,
 * AND IT WAS THE ONE CASE NOT DETECTED.
 *
 * Conflict detection compared INTERNAL against EXTERNAL only. So when a
 * workspace held a January policy handbook saying installation takes 7-10 days
 * and a March price list saying 3-4, the brief reported them as two unrelated
 * facts, side by side, with no indication that they cannot both be true:
 *
 *   [YOUR RECORDS ONLY] Interior installation normally takes 7 to 10 working days.
 *   [YOUR RECORDS ONLY] Installation is completed in 3 to 4 working days.
 *
 * A reader skimming that takes whichever they saw first. An agent quoting from
 * it promises a customer four days on a ten-day job, and the business finds out
 * when the customer is standing in an unfinished kitchen.
 *
 * Internal disagreement is more common than internal-versus-market, not less:
 * every business has a policy PDF, a website, a price list and a sales email
 * that were last reconciled at different times. It is also the easier case to
 * ACT on, because both sides belong to the owner — they can simply decide which
 * governs, which is exactly what the brief should ask them to do.
 *
 * Treated identically to a market conflict: both figures shown, both sources
 * named, no recommendation, never averaged. The one addition is that each side
 * names its document, because "which of my own files is right" is unanswerable
 * without knowing which files they were.
 */
export function detectInternalConflicts(
  facts: InternalFact[],
  tolerance = 0.15
): BriefFinding[] {
  const bySubject = new Map<string, InternalFact[]>();
  for (const f of facts) {
    if (!comparable(f)) continue;
    const key = normSubject(f.subject);
    if (!key) continue;
    const list = bySubject.get(key) || [];
    list.push(f);
    bySubject.set(key, list);
  }

  const out: BriefFinding[] = [];
  for (const [, group] of bySubject) {
    if (group.length < 2) continue;
    // Compare each pair once. Groups are tiny — a subject with more than a
    // handful of figures is a data problem of its own, and reporting every
    // pair is more honest than picking a representative.
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        // Same rule as the market comparison: units that cannot be reconciled
        // are not a disagreement, they are not a comparison at all.
        if (!sameUnit(a.unit, b.unit)) continue;
        if (!materiallyDiffers(
          toBase(a.value as number, a.unit),
          toBase(b.value as number, b.unit),
          tolerance
        )) continue;

        out.push({
          claim: `${a.subject}: your own records disagree — `
            + `${a.source} says ${renderQuantity(a.value as number, a.unit)}, `
            + `${b.source} says ${renderQuantity(b.value as number, b.unit)}.`,
          basis: 'conflict',
          confidence: 'internal_disagreement',
          caveat: 'Both of these are your own records, so no outside source can settle it. '
            + 'Decide which document governs and correct the other — until then an agent '
            + 'answering this question will be right only by luck.',
          internalSources: [a.source, b.source],
          externalSources: [],
        });
      }
    }
  }
  return out;
}

/** Turn raw retrieval dates into something a non-technical reader can act on. */
function buildFreshness(
  asOf: BuildBriefInput['internalAsOf']
): BriefFreshness | undefined {
  if (!asOf) return undefined;
  const total = Number(asOf.total || 0);
  if (total <= 0) return undefined;

  const stale = Number(asOf.stale || 0);
  const newest = asOf.newest;

  let note: string;
  if (!newest) {
    note = `Based on ${total} of your records. Their dates are unknown, so how current they are could not be checked.`;
  } else {
    const days = Math.floor((Date.now() - new Date(newest).getTime()) / 86400000);
    const age = !Number.isFinite(days) || days < 0
      ? 'an unknown age'
      : days === 0 ? 'today'
        : days === 1 ? 'yesterday'
          : days < 60 ? `${days} days ago`
            : `about ${Math.round(days / 30)} months ago`;
    note = days >= 180
      // The case worth shouting about: everything here predates the market data
      // it is being weighed against, by enough that the gap may BE the finding.
      ? `Your most recent record here was updated ${age}. Outside figures are current, `
        + 'so any gap between them may simply be the time in between. Confirm your own '
        + 'numbers are still right before acting on this.'
      : `Based on ${total} of your records, most recently updated ${age}.`;
    if (stale > 0) {
      note += ` ${stale} of the ${total} ${stale === 1 ? 'is' : 'are'} flagged as out of date.`;
    }
  }

  return { newest: asOf.newest, oldest: asOf.oldest, stale, total, note };
}

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
  // Directly under the verdict, not in a footnote. Someone who reads only the
  // first four lines of this brief should still know how old the evidence is.
  // Before anything else. A reader who takes only the first lines must not
  // walk away thinking a half was empty when it was unreachable.
  if (brief.unavailable) {
    const sides: string[] = [];
    if (brief.unavailable.internal) sides.push(`your own records (${brief.unavailable.internal})`);
    if (brief.unavailable.external) sides.push(`outside sources (${brief.unavailable.external})`);
    out.push(`INCOMPLETE — ${sides.join(' and ')} could not be read for this brief. `
      + 'That is a service problem, not a fact about your business.');
    out.push('');
  }
  if (brief.freshness) {
    out.push(brief.freshness.note);
    out.push('');
  }

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
