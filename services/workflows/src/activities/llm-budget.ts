/**
 * THE BUDGET GATE — read the meter, apply the rule, before the turn is paid for.
 *
 * This runs on the hot path of every agent turn, so it is one indexed query
 * against a rollup table rather than a scan of the proxy's spend log.
 *
 * ── FAIL OPEN, DELIBERATELY ───────────────────────────────────────────────
 * If the budget cannot be read — the table is missing, the connection is
 * refused, the function raises — this returns "unlimited" and lets the turn
 * proceed.
 *
 * That is the opposite of the usual instinct, and it is the right one here.
 * The failure being protected against is one tenant over-consuming; the
 * failure being risked by closing is EVERY tenant losing service because a
 * metering table had a bad day. A budget is a cost control, not a safety
 * control, and a cost control that can cause an outage is a worse problem than
 * the cost it was controlling.
 *
 * The fail-open path logs loudly, because a gate that is silently not running
 * is indistinguishable from a gate that is passing.
 */
import { Pool } from 'pg';

import { decideBudget, type BudgetDecision } from '../budget/budget.js';

/**
 * The LiteLLM alias for the zero-cost tier.
 *
 * Named `atomic-agent-deepseek` for historical reasons but mapped in
 * infra/litellm/config.yaml to nemotron-3-ultra:free — verified present in the
 * live OpenRouter catalogue and supporting tool calling, which the agent loop
 * requires. Overridable so a deployment with a different free route does not
 * have to patch code.
 */
const FREE_TIER_MODEL = process.env.LLM_FREE_TIER_MODEL || 'atomic-agent-deepseek';

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'darex_app',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'darex',
      max: 4,
    });
  }
  return pool;
}

export interface BudgetGateResult extends BudgetDecision {
  /** The model alias the turn should use, or undefined for normal routing. */
  modelOverride?: string;
  /** True when the limit could not be read and the turn was allowed anyway. */
  degradedOpen: boolean;
}

export async function checkLlmBudgetActivity(params: {
  orgId: string;
}): Promise<BudgetGateResult> {
  const { orgId } = params;

  let limitTokens: number | null = null;
  let usedTokens = 0;
  let onExceeded: 'degrade' | 'stop' = 'degrade';
  let warnAt = 0.8;

  try {
    const client = await getPool().connect();
    try {
      // llm_budget_status is SECURITY DEFINER and re-checks that the requested
      // org matches the session org, so this GUC is doing real work, not
      // ceremony: without it the function raises rather than leaking.
      await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
      const res = await client.query(
        `SELECT limit_tokens, used_tokens, on_exceeded, warn_at FROM llm_budget_status($1::uuid)`,
        [orgId],
      );
      const row = res.rows[0];
      if (row) {
        limitTokens = row.limit_tokens === null ? null : Number(row.limit_tokens);
        usedTokens = Number(row.used_tokens ?? 0);
        onExceeded = row.on_exceeded === 'stop' ? 'stop' : 'degrade';
        warnAt = Number(row.warn_at ?? 0.8);
      }
    } finally {
      try { await client.query('RESET app.current_org_id'); } catch { /* releasing anyway */ }
      client.release();
    }
  } catch (err) {
    // Loud, because a gate nobody can see is a gate nobody can trust.
    console.error(
      `[llm-budget] could not read the budget for org ${orgId}; allowing the turn. ` +
      `Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
    const open = decideBudget({ limitTokens: null, usedTokens: 0 });
    return { ...open, degradedOpen: true };
  }

  const decision = decideBudget({ limitTokens, usedTokens, onExceeded, warnAt });

  return {
    ...decision,
    modelOverride: decision.tier === 'free' ? FREE_TIER_MODEL : undefined,
    degradedOpen: false,
  };
}
