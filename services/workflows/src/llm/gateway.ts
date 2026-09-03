/**
 * THE ONE DOOR EVERY PAID MODEL CALL GOES THROUGH.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * The budget gate worked. It read the meter, decided to degrade, recorded a
 * `budget_exceeded` event and chose the free-tier alias. Then the turn spent
 * paid tokens anyway:
 *
 *     [PASS] the gate chose a replacement model — atomic-agent-deepseek
 *     [FAIL] every call ran on the zero-cost tier
 *            openrouter/deepseek/deepseek-chat, atomic-agent, atomic-agent
 *
 * Because the decision was handed to ONE caller. Five other call sites — the
 * critic, the reviser, memory write-back, the crew planner, market research —
 * each independently read `process.env.LITELLM_MODEL`, which is the PAID
 * alias, and none of them had ever heard of the budget.
 *
 * That is the same defect this codebase keeps producing, in its most expensive
 * form: every link was correct and the chain was not. Tenant isolation missed
 * a table; attribution missed three call sites; authorization did not
 * distinguish employees; the budget missed every path but one. Patching the
 * five call sites would fix today's symptom and guarantee the sixth.
 *
 * So the invariant is made structural instead of remembered:
 *
 *     A paid model call cannot execute unless it is attributed to an org
 *     AND that org's budget permits the tier it is about to use.
 *
 * There is one function that can reach the proxy. It requires an orgId, it
 * resolves the model from the budget rather than from the environment, and it
 * attributes every request. lint-llm-gateway.js fails the build if any other
 * file posts to chat/completions, so the sixth call site cannot be written
 * without either using this door or deliberately deleting the lock.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { checkLlmBudgetActivity } from '../activities/llm-budget.js';

/**
 * ── COUNTING WHAT WAS SPENT, WITHOUT PLUMBING ─────────────────────────────
 *
 * `monitor_used_model` on every supervision row was hard-coded `false`. It is
 * meant to be a COST alarm: if the share of tasks needing a model to judge
 * trends toward 1.0, the deterministic gates have stopped carrying their share
 * and the price per conversation is quietly tripling. Hard-coded, it could
 * never fire.
 *
 * The obvious fix — return a flag from the critic and thread it up — has to
 * cross five layers of critique/revision composition, and the reviser returns
 * a bare string, so the flag would have to change signatures the tests pin.
 * Worse, it would need re-threading for every future call site.
 *
 * Instead the door counts. Because the lint guarantees this is the ONLY
 * function that can reach the proxy, a counter here sees every paid call at
 * any depth, including ones written later by someone who never read this note.
 *
 * NOT a global counter: an async-local one, so concurrent activities on the
 * same worker cannot bleed into each other's tallies. Outside any scope the
 * store is undefined and nothing is counted, which is why this is safe to
 * leave in every path.
 */
interface LlmCallTally { dispatched: number }
const callScope = new AsyncLocalStorage<LlmCallTally>();

/**
 * Run `fn` and report how many paid calls it actually dispatched, at any depth.
 * Nested scopes count independently — the inner one wins for its own subtree.
 */
export async function countLlmCalls<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; dispatched: number }> {
  const tally: LlmCallTally = { dispatched: 0 };
  const result = await callScope.run(tally, fn);
  return { result, dispatched: tally.dispatched };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatParams {
  /**
   * Whose budget this spends. REQUIRED, and there is no default.
   *
   * An unattributed paid call is the thing that made per-tenant cost
   * unknowable for 1,125 calls, and it is not made impossible by remembering
   * to pass a field — it is made impossible by the type.
   */
  orgId: string;
  /** What this call is for. Appears in logs so a cost can be traced to a cause. */
  purpose: 'critic' | 'revise' | 'writeback' | 'crew-plan' | 'research' | 'agent-turn';
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Force a model. Only for callers that already resolved the budget themselves. */
  modelOverride?: string;
}

export interface LlmChatResult {
  content: string;
  /** What was actually asked for — not what the router finally used. */
  model: string;
  /** True when the budget forced this onto the zero-cost tier. */
  degraded: boolean;
  /** Set when the call did not happen. The caller decides what to do about it. */
  error?: 'not_configured' | 'budget_stop' | 'http_error' | 'timeout';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The budget is read once per org per short window, not once per call.
 *
 * A turn makes three to six model calls; asking the database each time would
 * put the meter on the hot path six times over for an answer that cannot
 * meaningfully change in between. Short enough that a budget change takes
 * effect within a turn or two, long enough that the gate is not itself the
 * cost.
 */
const BUDGET_TTL_MS = Number(process.env.LLM_BUDGET_CACHE_MS || 15_000);
const budgetCache = new Map<string, { at: number; model?: string; allowed: boolean; degraded: boolean }>();

/** Exposed so tests can assert behaviour across budget changes without waiting. */
export function clearBudgetCache(): void {
  budgetCache.clear();
}

async function resolveRouting(orgId: string): Promise<{ model: string; allowed: boolean; degraded: boolean }> {
  const paid = process.env.LITELLM_MODEL || 'atomic-agent';
  const cached = budgetCache.get(orgId);
  if (cached && Date.now() - cached.at < BUDGET_TTL_MS) {
    return { model: cached.model || paid, allowed: cached.allowed, degraded: cached.degraded };
  }

  const gate = await checkLlmBudgetActivity({ orgId });
  const model = gate.modelOverride || paid;
  const entry = {
    at: Date.now(),
    model,
    // `stop` is opt-in and rare; degrade is the default because a budget that
    // produces silence has reproduced the outage it was meant to prevent.
    allowed: gate.allowed,
    degraded: gate.tier === 'free',
  };
  budgetCache.set(orgId, entry);
  return { model, allowed: entry.allowed, degraded: entry.degraded };
}

/**
 * No call may be given less time than the slowest tier that can serve it.
 *
 * Callers pick a timeout from what the work is worth: the critic gets 12s, a
 * research synthesis gets 40s. Every one of those numbers was chosen against a
 * fast paid model.
 *
 * Measured 3 September 2026, inside the worker, twenty-token reply:
 *
 *   atomic-agent-fallback  gpt-4o-mini, paid          2 s
 *   atomic-agent           nvidia nemotron, FREE   28-38 s
 *
 * The free tier is the zero-cost floor of the failover chain, so it serves
 * whenever the paid tiers are exhausted, throttled or unfunded — the state this
 * deployment is in right now. Against it, a 12-second timeout is not a timeout.
 * It does not fail fast; it fails ALWAYS. The critic never runs, the reply skips
 * the gate it was supposed to pass, and nothing anywhere says so — every layer
 * is behaving exactly as written.
 *
 * So a floor, not a rewrite of every call site. A caller may still ask for MORE
 * than the floor when the work deserves it; it may not ask for less than the
 * serving tier can physically deliver.
 *
 * LLM_MIN_TIMEOUT_MS lowers it for a deployment that only ever uses fast paid
 * models, where failing fast is genuinely better.
 */
const MIN_TIMEOUT_MS = parseInt(process.env.LLM_MIN_TIMEOUT_MS || '60000', 10);

export function effectiveTimeoutMs(requested?: number): number {
  const asked = typeof requested === 'number' && requested > 0 ? requested : 30_000;
  return Math.max(asked, MIN_TIMEOUT_MS);
}

function chatUrl(): string | null {
  const isProd = process.env.NODE_ENV === 'production';
  const raw = process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  if (!raw) return null;
  const base = raw.replace(/\/$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/**
 * Ask a model something, on somebody's budget, attributed to them.
 *
 * Never throws. Every failure is a returned `error` with an empty `content`,
 * because every caller of this is inside an agent turn where an exception
 * means the customer gets silence — and silence is the failure mode this whole
 * system is built to avoid.
 */
export async function llmChat(params: LlmChatParams): Promise<LlmChatResult> {
  const paid = process.env.LITELLM_MODEL || 'atomic-agent';

  // THE INVARIANT, enforced before anything else can happen.
  if (!params.orgId || !UUID_RE.test(String(params.orgId).trim())) {
    console.error(
      `[llm-gateway] refusing an unattributed ${params.purpose} call: orgId is missing or not a uuid. `
      + 'Every paid call must name the workspace paying for it.',
    );
    return { content: '', model: paid, degraded: false, error: 'not_configured' };
  }

  const url = chatUrl();
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  if (!url || !apiKey) {
    return { content: '', model: paid, degraded: false, error: 'not_configured' };
  }

  let model = params.modelOverride || paid;
  let degraded = false;
  if (!params.modelOverride) {
    const routing = await resolveRouting(params.orgId);
    if (!routing.allowed) {
      // on_exceeded='stop'. The caller decides whether that means a fallback
      // reply or an escalation; the gateway's job is only to not spend.
      return { content: '', model: routing.model, degraded: true, error: 'budget_stop' };
    }
    model = routing.model;
    degraded = routing.degraded;
  }

  // ── PAST THIS LINE THE CALL COSTS MONEY ─────────────────────────────────
  // Every return above dispatched nothing: an unattributed call, a missing
  // endpoint, a budget stop. Counting here rather than at the top of the
  // function is the whole point — a tally that included refused calls would
  // report spend that never happened, and this number exists to catch spend
  // that did. A timeout or HTTP error below still counts: the request went out.
  const tally = callScope.getStore();
  if (tally) tally.dispatched += 1;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs(params.timeoutMs));
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: params.maxTokens ?? 800,
        temperature: params.temperature ?? 0,
        reasoning: { enabled: false },
        // LiteLLM records the request-body `user` as `end_user` in its spend
        // log. Without it the call is billed to the proxy's own key and no
        // tenant can be charged, capped, or shown what they spent.
        user: params.orgId,
        messages: params.messages,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { content: '', model, degraded, error: 'http_error' };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return {
      content: data?.choices?.[0]?.message?.content || '',
      model,
      degraded,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { content: '', model, degraded, error: aborted ? 'timeout' : 'http_error' };
  } finally {
    clearTimeout(timer);
  }
}
