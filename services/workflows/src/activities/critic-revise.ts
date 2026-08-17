/**
 * Critic-driven self-revision — bounded, auditable, fail-closed.
 *
 * WHY THIS EXISTS
 * Today a blocked draft goes straight to a human (`markNeedsAttentionActivity`).
 * That is safe but expensive: every quality wobble becomes an interruption, and
 * "this AI keeps pinging me" is what gets these products switched off. Most
 * blocks are mundane — an overclaim to delete, a disclosure to add — and the
 * agent can fix them itself.
 *
 * THE SAFETY MODEL (read before changing anything here)
 *
 *  1. THE CRITIC IS NEVER WEAKENED, SKIPPED, OR ARGUED WITH.
 *     A revision is just another draft. It must pass the SAME gate, from
 *     scratch, on its own merits. This module cannot approve anything — only
 *     the critic can. There is deliberately no "override" path.
 *
 *  2. NOT EVERY BLOCK IS REVISABLE.
 *     `fair_housing` is escalate-only. If a model emitted discriminatory
 *     content, letting it retry until it slips past a regex produces text that
 *     evades the filter while keeping the intent — strictly worse than
 *     escalating, because it looks clean. Discrimination is a human decision.
 *     `legal_promise` and `rera` are revisable: those fixes are subtractive
 *     (drop the guarantee) or additive (include the registration number).
 *
 *  3. BOUNDED, ALWAYS.
 *     Hard cap on attempts, and a no-progress guard so an unchanged draft ends
 *     the loop immediately. There is no path that spins.
 *
 *  4. FAILS CLOSED.
 *     Anything unresolved after the cap escalates to a human — the exact
 *     behaviour that exists today. This can only reduce escalations, never
 *     let something through that would have been stopped.
 *
 *  5. EVERY ATTEMPT IS RECORDED.
 *     The full chain (draft, verdict, violations) is returned for audit, so
 *     "why did this go out?" is always answerable.
 */

import type { CriticCheckResult, CriticIntent, CriticPolicy } from './critic-check.js';

/** Policies where automated revision is permitted. See safety note 2. */
const REVISABLE_POLICIES: ReadonlySet<CriticPolicy> = new Set<CriticPolicy>([
  'legal_promise',
  'rera',
  'model',
  // An unsupported figure is the most mechanically fixable failure there is:
  // remove it, or look it up. Exactly the case self-revision should handle
  // instead of interrupting a human.
  'grounding',
]);

/**
 * Policies that must always reach a human.
 *
 * Kept as an explicit deny-list *in addition* to the allow-list above so that a
 * future policy added to `CriticPolicy` cannot silently become auto-revisable
 * by omission — `isRevisablePolicy` requires membership of the allow-list, and
 * this set documents intent for readers.
 */
export const ESCALATE_ONLY_POLICIES: ReadonlySet<CriticPolicy> = new Set<CriticPolicy>([
  'fair_housing',
]);

export function isRevisablePolicy(policy: CriticPolicy): boolean {
  if (ESCALATE_ONLY_POLICIES.has(policy)) return false;
  return REVISABLE_POLICIES.has(policy);
}

export interface ReviseAttempt {
  /** 0 = the original draft, 1..n = revisions. */
  attempt: number;
  draft: string;
  allowed: boolean;
  policy: CriticPolicy;
  reason: string;
  violations: string[];
  /** What the loop did in response to this verdict. */
  disposition: 'accepted' | 'revised' | 'escalated';
}

export interface ReviseOutcome {
  allowed: boolean;
  /** The draft to send. ONLY safe to use when `allowed` is true. */
  finalDraft: string;
  /** Every draft considered, in order — the audit trail. */
  attempts: ReviseAttempt[];
  revisionsUsed: number;
  /** Populated when `allowed` is false; the reason a human is needed. */
  escalationReason?: string;
  /** Why the loop stopped. Useful for measuring where revision pays off. */
  stopReason:
    | 'allowed_first_try'
    | 'allowed_after_revision'
    | 'policy_not_revisable'
    | 'revision_budget_exhausted'
    | 'no_progress'
    | 'reviser_failed';
}

export interface ReviseDeps {
  /** The real critic. Must be the unmodified gate. */
  critique: (draft: string, intent: CriticIntent) => Promise<CriticCheckResult>;
  /**
   * Produce a corrected draft given the failing verdict. May throw or return
   * empty; both are treated as "cannot fix" and escalate.
   */
  revise: (draft: string, verdict: CriticCheckResult) => Promise<string>;
}

export interface ReviseOptions {
  /**
   * Maximum revision attempts after the original. Deliberately small: if two
   * targeted attempts cannot fix it, a third is unlikely to, and each one costs
   * a model call plus latency on a customer-facing reply.
   */
  maxRevisions?: number;
}

export const DEFAULT_MAX_REVISIONS = 2;

/** Normalised comparison for the no-progress guard. */
function sameText(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');
}

/**
 * Run the critic, revising on failure, until allowed or out of budget.
 *
 * Dependencies are injected so the whole loop is testable without a model or a
 * database — the safety properties above are asserted in critic-revise.test.ts.
 */
export async function reviseUntilAllowed(
  initialDraft: string,
  intent: CriticIntent,
  deps: ReviseDeps,
  options: ReviseOptions = {}
): Promise<ReviseOutcome> {
  const maxRevisions = Math.max(0, options.maxRevisions ?? DEFAULT_MAX_REVISIONS);
  const attempts: ReviseAttempt[] = [];

  let draft = initialDraft;
  let revisionsUsed = 0;

  for (let attempt = 0; ; attempt++) {
    const verdict = await deps.critique(draft, intent);

    if (verdict.allow) {
      attempts.push({
        attempt,
        draft,
        allowed: true,
        policy: verdict.policy,
        reason: verdict.reason,
        violations: verdict.violations ?? [],
        disposition: 'accepted',
      });
      return {
        allowed: true,
        finalDraft: draft,
        attempts,
        revisionsUsed,
        stopReason: attempt === 0 ? 'allowed_first_try' : 'allowed_after_revision',
      };
    }

    // Blocked. Decide whether this class of failure may be auto-corrected.
    if (!isRevisablePolicy(verdict.policy)) {
      attempts.push({
        attempt,
        draft,
        allowed: false,
        policy: verdict.policy,
        reason: verdict.reason,
        violations: verdict.violations ?? [],
        disposition: 'escalated',
      });
      return {
        allowed: false,
        finalDraft: draft,
        attempts,
        revisionsUsed,
        escalationReason: `${verdict.reason} (policy '${verdict.policy}' requires human review)`,
        stopReason: 'policy_not_revisable',
      };
    }

    if (revisionsUsed >= maxRevisions) {
      attempts.push({
        attempt,
        draft,
        allowed: false,
        policy: verdict.policy,
        reason: verdict.reason,
        violations: verdict.violations ?? [],
        disposition: 'escalated',
      });
      return {
        allowed: false,
        finalDraft: draft,
        attempts,
        revisionsUsed,
        escalationReason: `${verdict.reason} (unresolved after ${revisionsUsed} revision attempt(s))`,
        stopReason: 'revision_budget_exhausted',
      };
    }

    attempts.push({
      attempt,
      draft,
      allowed: false,
      policy: verdict.policy,
      reason: verdict.reason,
      violations: verdict.violations ?? [],
      disposition: 'revised',
    });

    let revised: string;
    try {
      revised = await deps.revise(draft, verdict);
    } catch (err: any) {
      return {
        allowed: false,
        finalDraft: draft,
        attempts,
        revisionsUsed,
        escalationReason: `revision failed: ${err?.message || 'unknown error'}`,
        stopReason: 'reviser_failed',
      };
    }

    const next = (revised || '').trim();
    if (!next) {
      return {
        allowed: false,
        finalDraft: draft,
        attempts,
        revisionsUsed,
        escalationReason: 'revision failed: reviser returned an empty draft',
        stopReason: 'reviser_failed',
      };
    }

    // No-progress guard: re-checking identical text would burn the budget for a
    // guaranteed-identical verdict.
    if (sameText(next, draft)) {
      return {
        allowed: false,
        finalDraft: draft,
        attempts,
        revisionsUsed,
        escalationReason: `${verdict.reason} (reviser produced no change)`,
        stopReason: 'no_progress',
      };
    }

    draft = next;
    revisionsUsed += 1;
  }
}

/**
 * Ask LiteLLM for a corrected draft.
 *
 * Mirrors `criticWithLiteLLM`'s conventions (same base URL/key resolution,
 * abort timeout, temperature 0). Returns '' when the gateway is unavailable —
 * the caller treats that as "cannot fix" and escalates, so an LLM outage
 * degrades to today's behaviour rather than blocking a customer reply.
 */
export async function reviseDraftWithLiteLLM(
  draft: string,
  verdict: CriticCheckResult,
  /**
   * Override the correction instruction. The reply gate passes
   * `buildGroundingFixPrompt` for grounding failures, which tells the model to
   * remove or retrieve the figure — and explicitly forbids hedging it, since
   * "approximately <invented number>" is the same fabrication with a qualifier.
   */
  promptOverride?: string
): Promise<string> {
  const isProd = process.env.NODE_ENV === 'production';
  const rawBase = process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  const model = process.env.LITELLM_MODEL || 'atomic-agent';
  if (!rawBase || !apiKey) return '';

  const baseUrl = rawBase.replace(/\/$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 500,
        temperature: 0,
        reasoning: { enabled: false },
        messages: [
          {
            role: 'system',
            content: [
              'You rewrite outbound business messages that failed a compliance check.',
              'Return ONLY the corrected message text — no preamble, no explanation, no quotes.',
              'Never promise guaranteed or assured returns, yields, or loan approvals.',
              'Never target or exclude people by faith, family status, disability, or source of income.',
              'Do not invent facts, figures, or registration numbers.',
            ].join(' '),
          },
          { role: 'user', content: promptOverride || buildRevisionPrompt(draft, verdict) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return '';
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content || '';
    // Models often wrap prose in fences or quotes despite instructions.
    return content
      .trim()
      .replace(/^```(?:\w+)?\s*/i, '')
      .replace(/```$/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Instruction for the revising model.
 *
 * Deliberately framed as "rewrite to comply", never "explain why this is fine".
 * The model has no route to approval — its output is re-judged from scratch —
 * so the only useful behaviour is an actual fix.
 */
export function buildRevisionPrompt(draft: string, verdict: CriticCheckResult): string {
  const violations = (verdict.violations ?? []).join(', ') || 'unspecified';
  return [
    'Your previous draft was BLOCKED by a compliance check. Rewrite it so it complies.',
    '',
    `Policy: ${verdict.policy}`,
    `Reason: ${verdict.reason}`,
    `Specific violations: ${violations}`,
    '',
    'Rules:',
    '- Remove or correct ONLY what caused the block; keep the rest of the meaning intact.',
    '- Do not argue, apologise, or explain — return the corrected message only.',
    '- Never promise guaranteed returns, yields, or approvals.',
    '- Include any legally required disclosure the check says is missing.',
    '- Do not mention this compliance check to the recipient.',
    '',
    'BLOCKED DRAFT:',
    draft,
    '',
    'CORRECTED MESSAGE:',
  ].join('\n');
}
