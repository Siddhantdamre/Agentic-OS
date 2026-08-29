/**
 * PER-TENANT LLM BUDGET — the decision, as pure arithmetic.
 *
 * One tenant's runaway loop currently drains the shared model pool for every
 * other tenant on the deployment. This module is the part that decides what to
 * do about it. It is deliberately pure: no database, no clock, no network, so
 * every rule below can be pinned by a unit test rather than discovered in
 * production.
 *
 * ── WHY THE LIMIT IS IN TOKENS AND NOT IN MONEY ───────────────────────────
 *
 * Because the money figure available per-tenant is wrong, and wrong in the
 * direction that never fires the alarm.
 *
 * Migration 027 already documents this for the deployment-wide burn rate:
 * LiteLLM prices a call from its built-in model table, which has no correct
 * entry for these OpenRouter routes. Measured on this deployment:
 *
 *   openrouter/nvidia/nemotron-...:free   2,280 calls   46,034,270 tokens   $0.00
 *   openrouter/deepseek/deepseek-chat       466 calls    7,785,722 tokens   $2.56
 *
 * The free tier is genuinely $0, so that row is correct. The problem is that
 * 46 million tokens of real capacity — the thing another tenant is being
 * starved of — costs nothing and would therefore never count against a
 * dollar-denominated budget. A tenant could consume the entire free-tier daily
 * allowance for the whole deployment and register as $0.00 of 50.00 used.
 *
 * Tokens are the one per-tenant quantity LiteLLM counts accurately (027 says
 * so explicitly, and it is why that table is trusted for volume). So tokens are
 * what the limit is denominated in and what enforcement reads. Money is shown
 * alongside as an ESTIMATE, clearly labelled, and is never the thing that
 * fires the gate.
 *
 * ── WHY THE DEFAULT IS DEGRADE AND NOT STOP ───────────────────────────────
 *
 * infra/litellm/config.yaml records what happened when every tier could fail
 * at once: the balance hit zero and 11 of 12 conversations got no reply. The
 * lesson written there is that silence is the worst failure mode, because it
 * is indistinguishable from the product being broken.
 *
 * A budget that stops is a self-inflicted version of that outage. So the
 * default is to degrade to the free tier: the tenant keeps answering, more
 * slowly and on a weaker model, and somebody is told. `stop` exists because a
 * customer may genuinely want a hard ceiling, but it is opt-in, and it is
 * never silent.
 */

/** What the caller may do next. */
export type BudgetTier =
  /** Normal routing — the paid tier 1 with its usual failover chain. */
  | 'normal'
  /** Over budget, still serving: pinned to the zero-cost tier. */
  | 'free';

export type BudgetState =
  | 'ok'
  /** Past the warning line but still under the limit. Nothing is restricted. */
  | 'warn'
  | 'exceeded'
  /** No limit configured for this tenant. */
  | 'unlimited';

export type OnExceeded =
  /** Keep answering on the free tier. The default, and the safe one. */
  | 'degrade'
  /** Refuse the turn. Opt-in only. */
  | 'stop';

export interface BudgetInput {
  /**
   * Tokens allowed in the current period. `null` means no limit — which is a
   * deliberate configuration, not a missing row: a tenant with no budget
   * record is unlimited, so introducing this feature cannot silently throttle
   * anybody who existed before it.
   */
  limitTokens: number | null;
  /** Tokens already consumed in the current period, from the usage rollup. */
  usedTokens: number;
  onExceeded?: OnExceeded;
  /**
   * Fraction of the limit at which to start warning. Warning changes nothing
   * about routing; it exists so the first a customer hears of a cap is not the
   * moment it bites.
   */
  warnAt?: number;
}

export interface BudgetDecision {
  /** False only for `stop`. Degrade still allows the turn. */
  allowed: boolean;
  tier: BudgetTier;
  state: BudgetState;
  /** null when unlimited — not 0, which would render as "0% used" on a dial. */
  pctUsed: number | null;
  limitTokens: number | null;
  usedTokens: number;
  /** Tokens left before the limit. null when unlimited, never negative. */
  remainingTokens: number | null;
  /** One plain sentence. This is shown to a human, so it says what and why. */
  reason: string;
}

const DEFAULT_WARN_AT = 0.8;

/**
 * Group digits explicitly, never by host locale.
 *
 * `toLocaleString()` with no argument follows the machine's locale, so the
 * same build produced "12,00,000" here and would produce "1,200,000" on a
 * server configured differently. Customer-facing text must not depend on
 * which host rendered it.
 *
 * en-IN is the deliberate choice: this product is sold to Indian businesses,
 * prices are quoted in rupees elsewhere in the ledger, and lakh grouping is
 * what an operator here reads without translating. It is pinned by a test so
 * a container locale cannot quietly change it.
 */
function group(n: number): string {
  return n.toLocaleString('en-IN');
}

/**
 * Treat anything that is not a finite, non-negative number as absent.
 *
 * A NaN limit arriving from a bad column read must not become an accidental
 * ceiling of zero — that would refuse every turn for that tenant on the
 * strength of a parse error.
 */
function cleanNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function decideBudget(input: BudgetInput): BudgetDecision {
  const limit = cleanNonNegative(input.limitTokens);
  const used = cleanNonNegative(input.usedTokens) ?? 0;
  const onExceeded: OnExceeded = input.onExceeded === 'stop' ? 'stop' : 'degrade';
  const warnAt =
    typeof input.warnAt === 'number' && input.warnAt > 0 && input.warnAt <= 1
      ? input.warnAt
      : DEFAULT_WARN_AT;

  // No limit: the tenant is unlimited and nothing else in here applies.
  if (limit === null) {
    return {
      allowed: true,
      tier: 'normal',
      state: 'unlimited',
      pctUsed: null,
      limitTokens: null,
      usedTokens: used,
      remainingTokens: null,
      reason: 'No budget limit is set for this workspace.',
    };
  }

  // A limit of exactly zero is a real instruction — "this tenant gets nothing"
  // — and is honoured rather than treated as unset. Percentage is undefined
  // against a zero denominator, so it is reported as null rather than as
  // Infinity, which would render on a dial as a blank or a crash.
  if (limit === 0) {
    const stop = onExceeded === 'stop';
    return {
      allowed: !stop,
      tier: stop ? 'normal' : 'free',
      state: 'exceeded',
      pctUsed: null,
      limitTokens: 0,
      usedTokens: used,
      remainingTokens: 0,
      reason: stop
        ? 'This workspace has a zero budget and is set to stop, so the request was refused.'
        : 'This workspace has a zero budget, so replies are running on the free model.',
    };
  }

  const pctUsed = Math.round((used / limit) * 1000) / 10;
  const remainingTokens = Math.max(0, limit - used);

  if (used >= limit) {
    const stop = onExceeded === 'stop';
    return {
      allowed: !stop,
      tier: stop ? 'normal' : 'free',
      state: 'exceeded',
      pctUsed,
      limitTokens: limit,
      usedTokens: used,
      remainingTokens: 0,
      reason: stop
        ? `This workspace has used ${group(used)} of its ${group(limit)} token budget and is set to stop, so the request was refused.`
        : `This workspace has used ${group(used)} of its ${group(limit)} token budget, so replies are running on the free model until the budget resets.`,
    };
  }

  if (used >= limit * warnAt) {
    return {
      allowed: true,
      tier: 'normal',
      state: 'warn',
      pctUsed,
      limitTokens: limit,
      usedTokens: used,
      remainingTokens,
      reason: `This workspace has used ${pctUsed}% of its token budget for this period.`,
    };
  }

  return {
    allowed: true,
    tier: 'normal',
    state: 'ok',
    pctUsed,
    limitTokens: limit,
    usedTokens: used,
    remainingTokens,
    reason: `This workspace has used ${pctUsed}% of its token budget for this period.`,
  };
}

/**
 * What the tokens probably cost, for display only.
 *
 * Derived from the provider's own reported spend over a sample window divided
 * by the token volume LiteLLM counted in that same window. That gives a real
 * blended rate per token across whatever mix of paid and free routes actually
 * ran, which is the only honest way to attach money to a token count here.
 *
 * It returns null rather than 0 when there is nothing to derive a rate from.
 * Zero is a claim — "this cost nothing" — and an absent rate is not that
 * claim. Every caller must render the null as "not known yet" and must label
 * the number as an estimate wherever it appears.
 */
export function estimateCostUsd(
  tokens: number,
  providerSpendUsd: number | null,
  providerTokens: number | null,
): number | null {
  const t = cleanNonNegative(tokens);
  const spend = cleanNonNegative(providerSpendUsd);
  const total = cleanNonNegative(providerTokens);
  if (t === null || spend === null || total === null || total === 0) return null;
  const rate = spend / total;
  // Six decimals: a single agent turn on this deployment is ~49k tokens, and
  // rounding to cents would show most tenants as costing $0.00.
  return Math.round(t * rate * 1e6) / 1e6;
}
