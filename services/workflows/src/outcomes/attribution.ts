/**
 * Outcome attribution — pure logic, no database.
 *
 * Kept free of I/O on purpose: attribution rules decide what a customer is told
 * their AI is worth, so every rule here is unit-testable in isolation and
 * cannot drift behind a mock.
 *
 * THE RULES THIS ENFORCES, AND WHY
 *
 *  1. An outcome attributes to AT MOST ONE action (last touch).
 *     Crediting every prior action for the same conversion is the standard way
 *     dashboards report more wins than actually happened.
 *
 *  2. An outcome must occur strictly AFTER its action, inside an explicit
 *     window. No window means no claim.
 *
 *  3. Weak (org-level, no shared conversation) attribution is OFF by default.
 *     It must be requested deliberately, and it is labelled `weak` forever.
 *
 *  4. Nothing here infers causation. Causal statements require a holdout arm;
 *     see `assignArm` and the `outcome_lift` view in migration 022.
 */

import { createHash } from 'crypto';

export type AttributionMethod = 'direct_reply' | 'same_conversation' | 'temporal_proximity';
export type AttributionStrength = 'strong' | 'moderate' | 'weak';
export type ExperimentArm = 'treatment' | 'holdout';

export interface AgentActionInput {
  id: string;
  conversationId: string | null;
  actionKind: string;
  /** Epoch milliseconds. */
  occurredAt: number;
}

export interface OutcomeEventInput {
  id: string;
  conversationId: string | null;
  outcomeKind: string;
  /** Epoch milliseconds. */
  occurredAt: number;
}

export interface AttributionEdge {
  actionId: string;
  outcomeId: string;
  method: AttributionMethod;
  strength: AttributionStrength;
  latencySeconds: number;
  windowSeconds: number;
  evidence: Record<string, unknown>;
}

export interface AttributionOptions {
  /**
   * How long after an action an outcome may still be attributed to it.
   * Stored on every edge — the same data under a different window is a
   * different claim, and reproducibility depends on recording which was used.
   */
  windowSeconds: number;
  /**
   * Permit org-level `temporal_proximity` edges (no shared conversation).
   * Default false: these are correlation with no thread linking them, and
   * shipping them by default would let weak claims quietly become headlines.
   */
  allowWeak?: boolean;
}

/** Outcomes that represent the agent doing badly. Never sold as wins. */
export const NEGATIVE_OUTCOMES = new Set([
  'human_took_over',
  'human_rejected',
  'feedback_negative',
]);

export function isNegativeOutcome(outcomeKind: string): boolean {
  return NEGATIVE_OUTCOMES.has(outcomeKind);
}

const DAY_SECONDS = 86_400;
export const DEFAULT_WINDOW_SECONDS = DAY_SECONDS;

/**
 * Deterministic experiment-arm assignment.
 *
 * Hash-based rather than random so the same conversation always lands in the
 * same arm — across retries, backfills and worker restarts. A conversation that
 * flipped arms mid-flight would corrupt the comparison the whole ledger rests on.
 *
 * @param unitId          stable identity of the randomisation unit (conversation id)
 * @param experimentKey   scopes the assignment, so two experiments do not
 *                        inherit each other's split
 * @param holdoutPercent  0–100. 0 disables holdouts entirely (no control group).
 */
export function assignArm(
  unitId: string,
  experimentKey: string,
  holdoutPercent: number
): ExperimentArm {
  if (!Number.isFinite(holdoutPercent) || holdoutPercent <= 0) return 'treatment';
  if (holdoutPercent >= 100) return 'holdout';

  const digest = createHash('sha256').update(`${experimentKey}:${unitId}`).digest();
  // First 4 bytes → uniform bucket in [0, 100).
  const bucket = (digest.readUInt32BE(0) / 0x1_0000_0000) * 100;
  return bucket < holdoutPercent ? 'holdout' : 'treatment';
}

function classify(
  action: AgentActionInput,
  outcome: OutcomeEventInput,
  interveningActions: number
): { method: AttributionMethod; strength: AttributionStrength } {
  const sameConversation =
    action.conversationId !== null &&
    outcome.conversationId !== null &&
    action.conversationId === outcome.conversationId;

  if (!sameConversation) {
    return { method: 'temporal_proximity', strength: 'weak' };
  }

  // Strongest defensible case: the agent sent a reply and the customer answered
  // it, with nothing else from the agent in between. Close to unambiguous.
  if (
    action.actionKind === 'reply_sent' &&
    outcome.outcomeKind === 'customer_replied' &&
    interveningActions === 0
  ) {
    return { method: 'direct_reply', strength: 'strong' };
  }

  // Same thread and inside the window, but the link is circumstantial: a booked
  // meeting may owe as much to a phone call as to this message.
  return { method: 'same_conversation', strength: 'moderate' };
}

/**
 * Attribute outcomes to actions.
 *
 * Last-touch: each outcome is credited to the most recent qualifying action
 * that preceded it. Deterministic and order-independent — inputs are sorted
 * internally, so callers cannot change the result by changing row order.
 */
export function attributeOutcomes(
  actions: AgentActionInput[],
  outcomes: OutcomeEventInput[],
  options: AttributionOptions
): AttributionEdge[] {
  const windowSeconds = options.windowSeconds;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error('attributeOutcomes: windowSeconds must be a positive number');
  }
  const allowWeak = options.allowWeak === true;
  const windowMs = windowSeconds * 1000;

  const sortedActions = [...actions].sort(
    (a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id)
  );
  const sortedOutcomes = [...outcomes].sort(
    (a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id)
  );

  const edges: AttributionEdge[] = [];

  for (const outcome of sortedOutcomes) {
    // Candidates: strictly before the outcome and inside the window.
    // Strict `<` matters — an action and outcome sharing a timestamp cannot be
    // ordered, and guessing would manufacture credit.
    const candidates = sortedActions.filter(
      (a) =>
        a.occurredAt < outcome.occurredAt &&
        outcome.occurredAt - a.occurredAt <= windowMs
    );
    if (candidates.length === 0) continue;

    // Prefer same-conversation candidates; fall back to org-level only when
    // weak attribution was explicitly requested.
    const sameConv = candidates.filter(
      (a) =>
        a.conversationId !== null &&
        outcome.conversationId !== null &&
        a.conversationId === outcome.conversationId
    );

    let pool = sameConv;
    if (pool.length === 0) {
      if (!allowWeak) continue;
      pool = candidates;
    }

    // Last touch.
    const action = pool[pool.length - 1];

    // How many other agent actions landed between this action and the outcome
    // in the same conversation — the signal for strong vs moderate.
    const interveningActions =
      action.conversationId === null
        ? 0
        : sortedActions.filter(
            (a) =>
              a.conversationId === action.conversationId &&
              a.occurredAt > action.occurredAt &&
              a.occurredAt < outcome.occurredAt
          ).length;

    const { method, strength } = classify(action, outcome, interveningActions);
    if (strength === 'weak' && !allowWeak) continue;

    const latencySeconds = Math.floor((outcome.occurredAt - action.occurredAt) / 1000);

    edges.push({
      actionId: action.id,
      outcomeId: outcome.id,
      method,
      strength,
      latencySeconds,
      windowSeconds,
      evidence: {
        actionKind: action.actionKind,
        outcomeKind: outcome.outcomeKind,
        conversationId: action.conversationId,
        candidateActions: candidates.length,
        interveningActions,
        selection: 'last_touch',
        negativeOutcome: isNegativeOutcome(outcome.outcomeKind),
      },
    });
  }

  return edges;
}

export interface LedgerSummary {
  totalActions: number;
  attributedActions: number;
  unattributedActions: number;
  byStrength: Record<AttributionStrength, number>;
  negativeOutcomes: number;
  /** Share of actions with any attributed outcome, 0–1. */
  attributionRate: number;
}

/**
 * Summarise a set of edges against the actions that produced them.
 *
 * Denominator is ALL actions, including those that achieved nothing. Reporting
 * only over attributed pairs is the most common way these dashboards flatter
 * themselves, and it is what makes buyers stop believing the numbers.
 */
export function summarize(
  actions: AgentActionInput[],
  edges: AttributionEdge[]
): LedgerSummary {
  const attributed = new Set(edges.map((e) => e.actionId));
  const byStrength: Record<AttributionStrength, number> = { strong: 0, moderate: 0, weak: 0 };
  let negativeOutcomes = 0;

  for (const edge of edges) {
    byStrength[edge.strength] += 1;
    if (edge.evidence?.negativeOutcome === true) negativeOutcomes += 1;
  }

  const totalActions = actions.length;
  return {
    totalActions,
    attributedActions: attributed.size,
    unattributedActions: totalActions - attributed.size,
    byStrength,
    negativeOutcomes,
    attributionRate: totalActions === 0 ? 0 : attributed.size / totalActions,
  };
}
