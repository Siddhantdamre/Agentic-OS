/**
 * SHADOW MODE — would the agent have done what you did?
 *
 * WHY THIS IS THE MOST USEFUL NUMBER IN THE PRODUCT
 * Every objection to letting an AI act reduces to one sentence: "I don't trust
 * it." Demos do not answer that, and neither does a resolution rate — a high
 * one only proves the agent handled the easy cases. What answers it is
 * evidence about THIS business's own judgement:
 *
 *   "Over your last 50 decisions, the agent would have done the same thing 47
 *    times. Here are the 3 it got wrong, and what you did instead."
 *
 * That is computable from data already collected. reply_edits holds the draft
 * beside what the operator actually sent; approval_requests holds what the
 * agent wanted to do beside what the human decided. Nobody else can show this
 * because nobody else stores the pairing.
 *
 * WHAT THIS NUMBER IS NOT
 * It is NOT an accuracy score. The human is not ground truth for correctness —
 * they are ground truth for what THIS business would have done. An agent that
 * agrees 100% with an operator who is themselves wrong is agreeing perfectly
 * and performing badly. The wording everywhere says "agreed with you", never
 * "was right", and that distinction has to survive contact with marketing.
 *
 * PURE — no clock, no database. The honesty rules below are unit-testable.
 */

export type AgreementSource = 'reply' | 'approval';

export interface AgreementCase {
  source: AgreementSource;
  /** What the agent proposed. */
  proposed: string;
  /**
   * What the human did with it.
   *  reply    — the text they actually sent
   *  approval — 'approved' or 'rejected'
   */
  humanOutcome: string;
  /** Present on a rejection: why the human said no. */
  reason?: string;
  at?: string;
}

export type Verdict = 'agreed' | 'cosmetic' | 'disagreed';

export interface AgreementCaseResult extends AgreementCase {
  verdict: Verdict;
}

export interface AgreementSummary {
  decided: number;
  agreed: number;
  cosmetic: number;
  disagreed: number;
  /**
   * null below MIN_SAMPLE. "3 of 4" is not 75% in any sense a business should
   * act on, and a percentage over four data points invites exactly the
   * decision it cannot support.
   */
  agreementPct: number | null;
  /** The disagreements, which are the only rows worth reading. */
  disagreements: AgreementCaseResult[];
  bySource: Record<AgreementSource, { decided: number; agreed: number }>;
}

/**
 * Below this many decisions, report counts and refuse a percentage.
 *
 * Ten is low for statistics and high enough to stop a number that swings 25
 * points per data point from being put in front of anyone.
 */
export const MIN_SAMPLE = 10;

/**
 * Normalise before comparing.
 *
 * Whitespace, case and surrounding punctuation are not judgement. An operator
 * who fixed a double space did not disagree with the agent, and counting that
 * as a disagreement makes the number pessimistic in a way that hides the real
 * ones.
 */
function normalise(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/g, '')
    .trim();
}

/**
 * Did the human accept what the agent proposed?
 *
 * DELIBERATELY STRICT: anything other than an identical normalised string is a
 * disagreement. A looser similarity threshold would call "30 days" -> "45
 * days" a 95% match and score it as agreement, when it is the single most
 * important correction a business could make. The bias here is toward
 * UNDER-counting agreement, because the cost of overstating it is a business
 * granting autonomy it should not have.
 */
export function judge(c: AgreementCase): Verdict {
  if (c.source === 'approval') {
    return c.humanOutcome === 'approved' ? 'agreed' : 'disagreed';
  }
  const proposed = (c.proposed || '').trim();
  const sent = (c.humanOutcome || '').trim();
  if (!proposed || !sent) return 'disagreed';
  if (proposed === sent) return 'agreed';
  if (normalise(proposed) === normalise(sent)) return 'cosmetic';
  return 'disagreed';
}

export function summariseAgreement(cases: AgreementCase[]): AgreementSummary {
  const bySource: AgreementSummary['bySource'] = {
    reply: { decided: 0, agreed: 0 },
    approval: { decided: 0, agreed: 0 },
  };
  const disagreements: AgreementCaseResult[] = [];
  let agreed = 0;
  let cosmetic = 0;
  let disagreed = 0;

  for (const c of cases || []) {
    const verdict = judge(c);
    const bucket = bySource[c.source];
    if (bucket) {
      bucket.decided++;
      // A cosmetic edit counts as agreement: the operator sent the agent's
      // answer, having tidied it. Counted separately as well, so the headline
      // can never hide how much tidying is going on.
      if (verdict !== 'disagreed') bucket.agreed++;
    }
    if (verdict === 'agreed') agreed++;
    else if (verdict === 'cosmetic') cosmetic++;
    else { disagreed++; disagreements.push({ ...c, verdict }); }
  }

  const decided = agreed + cosmetic + disagreed;
  return {
    decided,
    agreed,
    cosmetic,
    disagreed,
    agreementPct: decided >= MIN_SAMPLE
      ? Math.round(((agreed + cosmetic) / decided) * 1000) / 10
      : null,
    // Newest first — the recent ones are the ones worth acting on.
    disagreements: disagreements.slice().reverse(),
    bySource,
  };
}

/**
 * One sentence a business owner can act on.
 *
 * Says "agreed with you", never "was right". Refuses to produce a headline at
 * all below MIN_SAMPLE rather than producing a confident-sounding one.
 */
export function agreementSentence(s: AgreementSummary): string {
  if (s.decided === 0) {
    return 'No decisions yet — the agent has not proposed anything you have ruled on.';
  }
  if (s.agreementPct === null) {
    return `${s.agreed + s.cosmetic} of ${s.decided} so far. `
      + `Too few to put a figure on — ${MIN_SAMPLE} decisions makes it meaningful.`;
  }
  return `Over your last ${s.decided} decisions, the agent would have done the same `
    + `thing ${s.agreed + s.cosmetic} times (${s.agreementPct}%).`;
}
