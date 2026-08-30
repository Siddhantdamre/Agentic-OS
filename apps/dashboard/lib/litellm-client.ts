import { checkLlmBudgetActivity } from '@darex/workflows/dist/activities/llm-budget';
// Minimal OpenAI-compatible client for LiteLLM, used by the classify/plan/revise
// paths. These are plain chat completions that must return a single JSON object
// (or plain text) — they intentionally bypass atomic-agent's agent loop, which
// would inject the full tool grammar and try to execute tools.

function resolveLiteLLMConfig(): { baseUrl: string; apiKey: string; model: string } {
  const isProd = process.env.NODE_ENV === 'production';
  const baseUrl =
    process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  const model = process.env.LITELLM_MODEL || 'atomic-agent';

  if (!baseUrl) {
    throw new Error('LITELLM_BASE_URL must be set');
  }
  if (!apiKey) {
    throw new Error('LITELLM_API_KEY or LITELLM_MASTER_KEY must be set');
  }
  return { baseUrl, apiKey, model };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Whose budget this spends. REQUIRED, and deliberately not optional.
   *
   * The dashboard had its own path to the model — classify, crew planning and
   * plan generation all came through here — and none of it consulted the
   * per-workspace budget or attributed the spend. Making this required rather
   * than optional means the compiler finds every caller, which is the only way
   * to be sure none was missed; an optional field would have been forgotten in
   * exactly the places nobody thought to look.
   */
  orgId: string;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<string> {
  const { baseUrl, apiKey } = resolveLiteLLMConfig();
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 120000;

  // THE MODEL COMES FROM THE WORKSPACE'S BUDGET, not from LITELLM_MODEL.
  //
  // The dashboard had its own route to the proxy — classification, crew
  // planning, plan generation and draft revision all arrived here — and every
  // one of them read the paid alias out of the environment. A workspace that
  // the budget gate had already degraded to the free tier went on paying full
  // price for all four, because the gate and this file had never met.
  //
  // checkLlmBudgetActivity fails OPEN by design: if the meter cannot be read
  // the turn proceeds on the normal tier, because a cost control that causes
  // an outage is a worse problem than the cost it was controlling.
  let model = process.env.LITELLM_MODEL || 'atomic-agent';
  try {
    const gate = await checkLlmBudgetActivity({ orgId: options.orgId });
    if (!gate.allowed) {
      // on_exceeded='stop'. Opt-in, rare, and the caller's fallback handles it.
      return '';
    }
    if (gate.modelOverride) model = gate.modelOverride;
  } catch {
    // Fail open, as above. The gate logs its own reason loudly.
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: options.maxTokens,
          temperature: options.temperature ?? 0,
          // deepseek-v4-flash is a reasoning model: it burns the token budget on
          // reasoning_content before emitting content, which makes small-budget
          // calls return empty and large ones hang. These paths only need the
          // final answer, so disable chain-of-thought.
          reasoning: { enabled: false },
          // LiteLLM records the request-body `user` as `end_user` in its spend
          // log. Without it the call is billed to the proxy's own key and no
          // workspace can be charged, capped, or shown what it spent.
          user: options.orgId,
          messages,
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
      }

      // Non-2xx: retry only on transient server/rate errors.
      const body = await res.text().catch(() => '');
      if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) {
        throw new Error(`LiteLLM HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      lastError = new Error(`LiteLLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    } catch (err: any) {
      controller.abort();
      // AbortError means the overall timeout elapsed — retrying is pointless.
      if (err?.name === 'AbortError') throw new Error(`LiteLLM request timed out after ${timeoutMs}ms`);
      lastError = err;
      if (attempt >= maxRetries) break;
    } finally {
      clearTimeout(timeout);
    }

    // Exponential backoff + jitter before the next attempt.
    await sleep(250 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
  }

  throw lastError ?? new Error('LiteLLM request failed');
}
