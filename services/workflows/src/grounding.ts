/**
 * Answer grounding — stop the agent stating facts it cannot support.
 *
 * Pure module (no Node/pg/fetch), so it is importable from the Temporal
 * workflow isolate as well as activities.
 *
 * WHY THIS IS THE HIGHEST-VALUE QUALITY LAYER
 * A business assistant is judged on its worst answer, not its average one. The
 * failure that ends trust is not a clumsy sentence — it is a confident, wrong,
 * specific number: "you have 3 overdue invoices totalling ₹45,000." Once an
 * owner catches one fabricated figure, every future number needs re-checking by
 * hand, and the product has negative value.
 *
 * So this checks the claims that actually matter:
 *   - numbers and money    (counts, totals, percentages, amounts)
 *   - dates and deadlines
 *   - identifiers          (invoice/ticket/booking references)
 * against the evidence the agent actually retrieved.
 *
 * WHAT THIS IS NOT
 * Not a fact-checker for the world, and not a style critic. It answers exactly
 * one question: "does the evidence in hand support this specific figure?" It
 * cannot tell whether a supported number is the RIGHT number to quote — only
 * that the agent did not invent it.
 *
 * DESIGN STANCE
 * Precision over recall, deliberately. A false alarm costs one revision pass;
 * a missed fabrication reaches the customer. But an over-eager checker that
 * flagged every sentence would train people to ignore it, so the extractors
 * below target high-risk tokens only and skip ordinary prose.
 */

export type ClaimKind = 'number' | 'money' | 'percentage' | 'date' | 'identifier';

export interface Claim {
  kind: ClaimKind;
  /** The exact token as written in the draft, e.g. "₹45,000" or "3". */
  text: string;
  /** Comparable form: digits only for numerics, uppercased for identifiers. */
  normalized: string;
  /** Surrounding words, so a human reviewer sees the claim in context. */
  context: string;
}

export interface GroundingReport {
  claims: Claim[];
  supported: Claim[];
  unsupported: Claim[];
  /** 0–1 over checkable claims. 1 when there is nothing to check. */
  groundingScore: number;
  /** True when every checkable claim is supported by the evidence. */
  fullyGrounded: boolean;
}

/**
 * Numbers that carry no factual weight and would only create noise:
 * small ordinals in prose ("the 2 options below"), times of day, and years,
 * which are usually context rather than a retrieved fact.
 */
const IGNORED_BARE_NUMBERS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '24']);

const MONEY_RE =
  /(?:[₹$€£]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:rupees?|inr|usd|dollars?|eur|euros?|gbp|pounds?|lakhs?|crores?)\b)/gi;
const PERCENT_RE = /\b\d+(?:\.\d+)?\s?%/g;
// ISO dates, D/M/Y, and "12 March" / "March 12" forms.
const DATE_RE =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2})\b/gi;
// Reference-looking tokens: INV-1042, #4821, TICKET_99. Must contain a digit.
const IDENTIFIER_RE = /\b(?:[A-Z][A-Z0-9]{1,}[-_/]?\d{2,}|#\d{2,})\b/g;
const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?\b/g;

function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 32);
  const end = Math.min(text.length, index + length + 32);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** Digits only — lets "₹45,000", "45000" and "45,000" compare equal. */
function normalizeNumeric(token: string): string {
  const digits = token.replace(/[^\d.]/g, '');
  // Trim a trailing ".00" so 45000 and 45000.00 match.
  return digits.replace(/\.0+$/, '');
}

/**
 * Pull checkable claims out of a draft.
 *
 * Ordering matters: money/percentage/date/identifier are matched first, and
 * their spans are then excluded from the bare-number pass so "₹45,000" is
 * reported once as money rather than twice.
 */
export function extractClaims(draft: string): Claim[] {
  const text = draft || '';
  const claims: Claim[] = [];
  const consumed: Array<[number, number]> = [];

  const sweep = (re: RegExp, kind: ClaimKind, normalize: (s: string) => string) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const token = m[0];
      consumed.push([m.index, m.index + token.length]);
      claims.push({
        kind,
        text: token.trim(),
        normalized: normalize(token),
        context: contextAround(text, m.index, token.length),
      });
    }
  };

  sweep(MONEY_RE, 'money', normalizeNumeric);
  sweep(PERCENT_RE, 'percentage', normalizeNumeric);
  sweep(DATE_RE, 'date', (s) => s.toLowerCase().replace(/\s+/g, ' ').trim());
  sweep(IDENTIFIER_RE, 'identifier', (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, ''));

  // Bare numbers last, skipping spans already claimed above.
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (consumed.some(([s, e]) => start >= s && end <= e)) continue;
    const normalized = normalizeNumeric(m[0]);
    if (IGNORED_BARE_NUMBERS.has(normalized)) continue;
    claims.push({
      kind: 'number',
      text: m[0],
      normalized,
      context: contextAround(text, start, m[0].length),
    });
  }

  return claims;
}

/**
 * Check each claim against the evidence the agent actually retrieved.
 *
 * `evidence` is the concatenation of everything the agent had: tool results,
 * retrieved memory, the conversation so far. A claim counts as supported when
 * its normalized form appears there — i.e. the agent read it somewhere rather
 * than producing it.
 *
 * Dates are matched loosely (the same date is written many ways); numerics are
 * matched on digits so formatting differences do not cause false alarms.
 */
const WEEKDAY_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend|today|tomorrow)\b/i;

/**
 * True when a claim is the agent resolving a calendar reference the evidence
 * already made, rather than asserting a business fact.
 *
 * Measured, not assumed. Asked "can we book a viewing for Saturday morning?"
 * the agent answered correctly from the knowledge base AND helpfully named the
 * date. The gate recorded `["date:22 Aug", "number:2026"]` as unsupported,
 * scored 33%, blocked the reply, and the customer got silence — the single
 * intermittent failure across the reliability runs.
 *
 * No document will ever contain next Saturday's date, so demanding evidence for
 * it is a requirement that can never be satisfied. Turning "Saturday" into
 * "Saturday 22 Aug" is arithmetic on today's date, not an invented fact.
 *
 * Deliberately narrow, because this is the fabrication guard:
 *   - a DATE is exempt only if the evidence itself names the weekday/relative
 *     day being resolved. An unprompted "your order ships 4 March" is still
 *     checked.
 *   - a bare 4-digit calendar YEAR is exempt. Nobody fabricates business data
 *     by writing "2026", and a year is never a figure a customer acts on.
 * Money, percentages, quantities and identifiers are untouched — those are what
 * fabrication actually looks like, and they still require evidence.
 */
function isCalendarInference(claim: Claim, haystack: string): boolean {
  if (claim.kind === 'date') {
    const weekdayInClaim = WEEKDAY_RE.exec(`${claim.text} ${claim.context}`);
    if (!weekdayInClaim) return false;
    // The evidence must be the source of that weekday.
    return haystack.includes(weekdayInClaim[0].toLowerCase());
  }
  if (claim.kind === 'number') {
    // A plausible calendar year, and only when the draft is talking about time.
    if (!/^(19|20|21)\d{2}$/.test(claim.normalized)) return false;
    return WEEKDAY_RE.test(claim.context)
      || /\b(?:on|by|from|until|before|after|date|month|year|week)\b/i.test(claim.context);
  }
  return false;
}

export function verifyClaims(
  claims: Claim[],
  evidence: string,
  dateContext = '',
): GroundingReport {
  const haystack = (evidence || '').toLowerCase();
  const digitsOnly = haystack.replace(/[^\d]/g, '');
  // Deliberately a second, separate haystack. Only `date` claims may consult
  // it — see GroundingPolicy.dateContext for why mixing the two let "Saturday
  // 30 August" ground an invented "30% off".
  const dateHay = (dateContext || '').toLowerCase();

  const supported: Claim[] = [];
  const unsupported: Claim[] = [];

  for (const claim of claims) {
    let ok = false;

    if (isCalendarInference(claim, haystack) || (claim.kind === 'date' && isCalendarInference(claim, dateHay))) {
      supported.push(claim);
      continue;
    }

    if (claim.kind === 'date') {
      // Any recognisable fragment of the date appearing in evidence is enough;
      // "2026-03-01" and "1 March" should not be treated as different facts.
      const parts = claim.normalized.split(/[\s\/-]+/).filter((p) => p.length >= 2);
      // A date may be supported by retrieved evidence OR by the dates the
      // platform supplied — but ONLY a date. dateHay is never consulted for
      // money, percentages or quantities, because "Saturday, 30 August" would
      // otherwise ground an invented "30% off".
      ok = parts.length > 0
        && (parts.every((p) => haystack.includes(p)) || parts.every((p) => dateHay.includes(p)));
    } else if (claim.kind === 'identifier') {
      ok = haystack.replace(/[^a-z0-9]/g, '').includes(claim.normalized.toLowerCase());
    } else {
      // Numeric: compare digit strings so ₹45,000 matches 45000 in a DB row.
      const n = claim.normalized.replace(/\./g, '');
      ok = n.length > 0 && digitsOnly.includes(n);
    }

    (ok ? supported : unsupported).push(claim);
  }

  const total = claims.length;
  return {
    claims,
    supported,
    unsupported,
    groundingScore: total === 0 ? 1 : supported.length / total,
    fullyGrounded: unsupported.length === 0,
  };
}

export interface GroundingPolicy {
  /**
   * Minimum share of claims that must be supported. Below this the reply is
   * held rather than sent. Default 1.0 — in a business context a single
   * invented figure is a failure, not a rounding error.
   */
  minGroundingScore?: number;
  /** Claim kinds that must ALWAYS be supported regardless of the score. */
  criticalKinds?: ClaimKind[];
  /**
   * Dates the PLATFORM supplied — today, last Monday, next Saturday and so on.
   *
   * Kept SEPARATE from evidence, and consulted only for `date` claims. Folding
   * them into the general evidence string was a real fabrication hole: on 23
   * August the block contains "Saturday, 30 August", and the digits "30" then
   * grounded an invented "30% off the order". Date context may license a date;
   * it must never license money, a percentage or a quantity.
   */
  dateContext?: string;
}

export interface GroundingVerdict {
  allow: boolean;
  reason: string;
  report: GroundingReport;
  /** Claims to name in a revision prompt so the agent can fix them. */
  offending: Claim[];
}

/**
 * Decide whether a draft may be sent.
 *
 * Money and identifiers are critical by default: a wrong amount or a wrong
 * invoice reference is directly actionable by the recipient and directly
 * damaging when wrong.
 */
export function evaluateGrounding(
  draft: string,
  evidence: string,
  policy: GroundingPolicy = {}
): GroundingVerdict {
  const minScore = policy.minGroundingScore ?? 1;
  const critical = new Set<ClaimKind>(policy.criticalKinds ?? ['money', 'identifier']);

  const report = verifyClaims(extractClaims(draft), evidence, policy.dateContext || '');

  const criticalMisses = report.unsupported.filter((c) => critical.has(c.kind));
  if (criticalMisses.length > 0) {
    return {
      allow: false,
      reason: `unsupported ${criticalMisses.map((c) => c.kind).join(', ')} in reply: ${criticalMisses
        .map((c) => c.text)
        .join(', ')}`,
      report,
      offending: criticalMisses,
    };
  }

  if (report.groundingScore < minScore) {
    return {
      allow: false,
      reason: `only ${Math.round(report.groundingScore * 100)}% of factual claims are supported by retrieved evidence`,
      report,
      offending: report.unsupported,
    };
  }

  return {
    allow: true,
    reason:
      report.claims.length === 0
        ? 'no checkable factual claims'
        : `${report.supported.length}/${report.claims.length} claims supported`,
    report,
    offending: [],
  };
}

/**
 * Instruction for correcting an ungrounded draft.
 *
 * Tells the agent to remove or retrieve — never to soften. "Approximately
 * ₹45,000" is not a fix for an invented ₹45,000; it is the same fabrication
 * with a hedge in front of it.
 */
export function buildGroundingFixPrompt(draft: string, verdict: GroundingVerdict): string {
  const list = verdict.offending.map((c) => `- ${c.text}  (in: ${c.context})`).join('\n');
  return [
    'Your draft states facts that are NOT supported by the data you retrieved.',
    '',
    'Unsupported:',
    list,
    '',
    'Rewrite it. For each unsupported item, either:',
    '  (a) remove the specific figure and say what you would need to look up, or',
    '  (b) replace it with a figure that appears in the retrieved data.',
    '',
    'Do NOT hedge an invented number ("about", "approximately", "roughly") — that is',
    'still a fabrication. Do not invent a source. Keep everything else unchanged.',
    '',
    'DRAFT:',
    draft,
    '',
    'CORRECTED:',
  ].join('\n');
}
