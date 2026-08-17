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
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<string> {
  const { baseUrl, apiKey, model } = resolveLiteLLMConfig();
  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 120000;

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
