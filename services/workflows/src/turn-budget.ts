/**
 * Adaptive turn budget for the autonomous agent loop.
 *
 * Replaces a hard-coded `MAX_TURNS = 3`, which gave "thanks!" the same compute
 * as "reconcile these three invoices, email the landlord, and book a viewing".
 *
 * DESIGN CONSTRAINTS (all load-bearing — do not relax without reading why)
 *
 *  1. PURE AND DETERMINISTIC.
 *     This runs inside a Temporal workflow. Workflow code is replayed from
 *     history on every worker restart, and any non-determinism corrupts the
 *     replay. So: no clock, no randomness, no I/O, no LLM call. The budget is
 *     a function of the task input alone, and the same input always yields the
 *     same number.
 *
 *  2. HARD CEILING, ALWAYS.
 *     Every path clamps to [MIN_TURNS, MAX_TURNS_CEILING]. An agent that can
 *     grant itself turns is an agent that can bill a customer indefinitely for
 *     a task it will never finish.
 *
 *  3. ASYMMETRIC RISK — bias upward.
 *     Granting a turn too many costs one LLM call. Granting one too few means
 *     abandoning the customer mid-task, which is far more expensive in trust.
 *     So the budget only drops below the default for input that is
 *     unambiguously trivial (a greeting, a thank-you), and is otherwise >= the
 *     old fixed value. Nothing gets *less* compute than it does today unless it
 *     plainly needs none.
 *
 *  4. EXPLAINABLE.
 *     Every budget carries the signals that produced it. "Why did this cost 6
 *     turns?" must be answerable from the work event, not by re-deriving it.
 *
 *  5. STUCK DETECTION IS SEPARATE FROM BUDGET.
 *     A large budget is permission to keep going, not an obligation. A turn
 *     that discovers nothing new ends the loop regardless of remaining budget —
 *     burning five turns to repeat the same failing tool call helps nobody.
 */

export const MIN_TURNS = 1;
export const DEFAULT_TURNS = 3;
export const MAX_TURNS_CEILING = 6;

export interface TurnBudgetSignals {
  /** Length of the user's message in characters. */
  messageLength: number;
  /** Count of '?' — several questions usually means several sub-tasks. */
  questionCount: number;
  /** Message contains sequencing language ("then", "after that", "also"). */
  hasMultiStepMarkers: boolean;
  /** Message enumerates work ("1.", "2)", bullet list). */
  hasEnumeration: boolean;
  /** Purely conversational: greeting, thanks, acknowledgement. */
  isTrivial: boolean;
  /** Number of tools this employee may use. */
  toolCount: number;
}

export interface TurnBudget {
  /** Turns granted. Always within [MIN_TURNS, MAX_TURNS_CEILING]. */
  turns: number;
  /** Human-readable justification, stored on the work event. */
  reason: string;
  /** The raw signals, for audit and for measuring whether this heuristic pays. */
  signals: TurnBudgetSignals;
}

const MULTI_STEP_RE =
  /\b(then|after that|afterwards|once (?:you|that)|and also|as well as|followed by|next,)\b/i;
const ENUMERATION_RE = /(^|\n)\s*(?:\d+[.)]\s|[-*•]\s)/;

/**
 * Conversational filler with no task in it.
 *
 * Deliberately strict: it must match the WHOLE message. "thanks — can you also
 * cancel the viewing?" is not trivial, and a loose `includes('thanks')` would
 * have starved it of turns.
 */
const TRIVIAL_RE =
  /^(?:\s*(?:hi|hello|hey|thanks|thank you|thx|ta|ok|okay|got it|great|perfect|cheers|bye|goodbye|good morning|good afternoon|good evening)[\s!.,]*)+$/i;

export function extractSignals(
  userMessage: string,
  toolAllowlist: readonly string[] = []
): TurnBudgetSignals {
  const text = (userMessage || '').trim();
  return {
    messageLength: text.length,
    questionCount: (text.match(/\?/g) || []).length,
    hasMultiStepMarkers: MULTI_STEP_RE.test(text),
    hasEnumeration: ENUMERATION_RE.test(text),
    isTrivial: text.length > 0 && text.length <= 64 && TRIVIAL_RE.test(text),
    toolCount: toolAllowlist.length,
  };
}

function clamp(n: number): number {
  return Math.max(MIN_TURNS, Math.min(MAX_TURNS_CEILING, n));
}

/**
 * Compute the turn budget for a task.
 *
 * Starts from today's fixed default and adjusts on evidence. An empty or
 * unreadable message yields exactly the old behaviour, so a signal-extraction
 * bug degrades to the status quo rather than to zero turns.
 */
export function computeTurnBudget(
  userMessage: string,
  toolAllowlist: readonly string[] = []
): TurnBudget {
  const signals = extractSignals(userMessage, toolAllowlist);

  if (signals.messageLength === 0) {
    return { turns: DEFAULT_TURNS, reason: 'empty message — default budget', signals };
  }

  // The only downward adjustment, and only for unambiguous filler. A reply to
  // "thanks!" needs one turn; spending three is pure latency and cost.
  if (signals.isTrivial) {
    return { turns: MIN_TURNS, reason: 'conversational acknowledgement — minimum budget', signals };
  }

  let turns = DEFAULT_TURNS;
  const reasons: string[] = [];

  if (signals.hasMultiStepMarkers) {
    turns += 1;
    reasons.push('sequencing language');
  }
  if (signals.hasEnumeration) {
    turns += 1;
    reasons.push('enumerated tasks');
  }
  if (signals.questionCount >= 3) {
    turns += 1;
    reasons.push(`${signals.questionCount} questions`);
  }
  // Long messages usually carry more context AND more asks. Threshold is high
  // so an ordinary paragraph does not inflate every budget.
  if (signals.messageLength >= 600) {
    turns += 1;
    reasons.push('long request');
  }

  const clamped = clamp(turns);
  const reason =
    reasons.length === 0
      ? 'no complexity signals — default budget'
      : `${reasons.join(', ')}${clamped < turns ? ' (clamped to ceiling)' : ''}`;

  return { turns: clamped, reason, signals };
}

export interface TurnProgress {
  /** New tools this turn used that no earlier turn had. */
  newTools: number;
  /** New execution steps recorded this turn. */
  newSteps: number;
  /** Whether this turn discovered anything at all. */
  madeProgress: boolean;
}

/**
 * Did this turn advance the task?
 *
 * The loop's existing continue-condition asks "did it use tools?", which is
 * true even when a turn re-runs the same failing call. This asks the stricter
 * question — did anything NEW happen — so a stuck agent stops instead of
 * spending its whole budget repeating itself.
 */
export function evaluateTurnProgress(
  toolsBefore: ReadonlySet<string>,
  toolsAfterTurn: readonly string[],
  stepsAddedThisTurn: number
): TurnProgress {
  let newTools = 0;
  for (const tool of toolsAfterTurn) {
    if (!toolsBefore.has(tool)) newTools += 1;
  }
  const newSteps = Math.max(0, stepsAddedThisTurn);
  return { newTools, newSteps, madeProgress: newTools > 0 || newSteps > 0 };
}
