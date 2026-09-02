/**
 * When the agent does not know something, should it go and find out?
 *
 * "I don't have that information" is a shrug, and a business does not want an
 * employee who shrugs. But the fix is not "always produce an answer" — that is
 * the fabrication path, and this product's whole claim is that it does not
 * invent. The fix is narrower and more useful:
 *
 *     LOOK IT UP WHEN LOOKING IT UP IS POSSIBLE.
 *     SAY WHERE YOU LOOKED WHEN IT IS NOT.
 *
 * Some questions can be answered from public sources and some cannot, and
 * getting that distinction wrong in one direction is far worse than the other.
 * The two real knowledge gaps in the demo workspace show both sides exactly:
 *
 *   "What is the stamp duty on a 1.2cr flat in Thane?"
 *        Public regulation. Any broker knows it. Every competitor's website
 *        states it. Refusing to answer is embarrassing and unnecessary.
 *
 *   "Do you have anything in Chembur under 90 lakh?"
 *        THIS BUSINESS'S INVENTORY. Nothing on the internet can answer it.
 *        Searching the web would surface a competitor's listing, and quoting
 *        it as ours is worse than any refusal — it is a fabricated property at
 *        a fabricated price, which for a broker is a lawsuit.
 *
 * So this module answers one question: may this be looked up?
 *
 * ── IT FAILS TOWARDS THE HUMAN ────────────────────────────────────────────
 * Ambiguity resolves to INTERNAL. An unclear question goes to a person rather
 * than to a search engine, because the cost of a wrong INTERNAL call is a
 * knowledge gap somebody answers once, and the cost of a wrong EXTERNAL call is
 * a confident answer about a property we do not have. Those are not comparable,
 * so the tie does not go to convenience. Same reasoning as ADR 12.
 */

export type Answerability = 'external' | 'internal';

export interface AnswerabilityVerdict {
  kind: Answerability;
  /** Why, in words an operator would accept. */
  reason: string;
  /** The phrase that decided it, when one did. */
  matched?: string;
}

/**
 * Marks of a question about THIS business: its stock, its people, its prices,
 * its records. No public source can answer these and none should be consulted.
 *
 * Second person and first person plural both point inward — "do you have",
 * "your rate", "our office". A customer asking a business "do you have X" is
 * asking about that business, never about the world.
 */
const INTERNAL_MARKERS: Array<[RegExp, string]> = [
  [/\b(?:do|did|does|can|could|will|would)\s+(?:you|u|we)\b/i, 'asks what this business has or does'],
  /**
   * Any possessive is internal, whatever noun follows.
   *
   * This was a list of nouns — your price, your rate, your listings — and the
   * test that caught it asked "what is the stamp duty on YOUR 2BHK in Chembur".
   * "2BHK" was not on the list, so the question fell through to the stamp-duty
   * rule and came back EXTERNAL: our own flat, sent to a web search. That is the
   * exact failure this module exists to prevent, and enumerating nouns will lose
   * that race forever — the next miss is "your penthouse", "your plot", "your
   * shop". A customer writing "your" means this business, always.
   */
  [/\byour\b/i, 'possessive: asks about this business'],
  [/\b(?:our|my)\b/i, 'possessive: asks about a record or dealing here'],
  [/\b(?:available|in stock|vacant|unsold|on offer|shortlisted)\b/i, 'asks about current inventory'],
  [/\bhow much (?:do|does|would) (?:you|we)\b/i, 'asks this business\'s pricing'],
  [/\b(?:status|update) (?:of|on) (?:my|our|the) \b/i, 'asks the status of a record here'],
  [/\b(?:when|what time) (?:can|will|do) (?:you|we)\b/i, 'asks this business\'s schedule'],
];

/**
 * Marks of a question about the world: law, tax, public rules, general facts.
 * These are what an informed employee is simply expected to know, and what a
 * business is embarrassed to be unable to answer.
 */
const EXTERNAL_MARKERS: Array<[RegExp, string]> = [
  [/\b(?:stamp duty|registration charge|registration fee|circle rate|ready reckoner|gst|tds|capital gains|income tax|property tax)\b/i, 'public tax or duty'],
  [/\b(?:rera|maharera|dtcp|rera number|occupancy certificate|completion certificate|khata|encumbrance)\b/i, 'public regulation or registry'],
  [/\b(?:home loan|loan eligibility|interest rate|emi|repo rate|ltv ratio)\b/i, 'published lending terms'],
  [/\b(?:what is|what are|what does|define|meaning of|difference between|how does .* work)\b/i, 'a general question of fact'],
  [/\b(?:law|rule|regulation|legal|statutory|government|municipal|policy) (?:on|for|about|regarding)\b/i, 'public rule'],
  [/\b(?:market rate|market price|average price|price trend|appreciation) (?:in|for|of)\b/i, 'published market data'],
];

/**
 * A question can carry both — "what is the stamp duty on YOUR 2BHK in Chembur"
 * is a public rule applied to our inventory. Internal wins: answering it needs
 * a fact only this business holds, and a public source cannot supply it.
 */
export function classifyAnswerability(question: string): AnswerabilityVerdict {
  const q = String(question || '').trim();
  if (!q) return { kind: 'internal', reason: 'empty question; nothing to look up' };

  for (const [re, why] of INTERNAL_MARKERS) {
    const m = q.match(re);
    if (m) return { kind: 'internal', reason: why, matched: m[0] };
  }

  for (const [re, why] of EXTERNAL_MARKERS) {
    const m = q.match(re);
    if (m) return { kind: 'external', reason: why, matched: m[0] };
  }

  // Nothing matched. Fail towards the human — see the header.
  return {
    kind: 'internal',
    reason: 'no public-fact marker found; treated as a question about this business',
  };
}

/**
 * The sentence to send when a lookup was attempted and came back empty.
 *
 * Deliberately not "I don't have that information". It names where it looked,
 * which is the difference between an employee who checked and one who shrugged,
 * and it commits a person rather than leaving the customer waiting.
 */
export function searchedButNotFound(question: string, sourcesTried: string[]): string {
  const where = sourcesTried.length
    ? ` I checked ${sourcesTried.slice(0, 3).join(', ')}`
    : ' I checked the sources available to me';
  return `I could not confirm that from a source I trust.${where}. `
    + 'Rather than guess, I am passing this to a colleague who will confirm and come back to you.';
}

/**
 * Should this denial trigger a web lookup before we accept it?
 *
 * Three conditions, all required:
 *   the agent actually denied knowledge,
 *   the question is answerable from public sources,
 *   and a retrieval tool is reachable.
 *
 * The third matters: attempting a lookup with no reachable tool produces a
 * slower version of the same denial and burns a model call to get there.
 */
export function shouldAttemptLookup(params: {
  isDenial: boolean;
  question: string;
  retrievalAvailable: boolean;
}): { attempt: boolean; reason: string } {
  if (!params.isDenial) return { attempt: false, reason: 'the agent answered; nothing to look up' };
  if (!params.retrievalAvailable) {
    return { attempt: false, reason: 'no retrieval tool is reachable in this workspace' };
  }
  const verdict = classifyAnswerability(params.question);
  if (verdict.kind === 'internal') {
    return { attempt: false, reason: `internal question — ${verdict.reason}; a person must answer it` };
  }
  return { attempt: true, reason: `public question — ${verdict.reason}` };
}
