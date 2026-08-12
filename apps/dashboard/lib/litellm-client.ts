// Minimal OpenAI-compatible client for LiteLLM, used by the classify/plan/revise
// paths. These are plain chat completions that must return a single JSON object
// (or plain text) — they intentionally bypass atomic-agent's agent loop, which
// would inject the full tool grammar and try to execute tools.

const LITELLM_BASE_URL =
  process.env.LITELLM_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'http://litellm:4000/v1' : 'http://localhost:4000/v1');
const LITELLM_API_KEY =
  process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || 'sk-darex-litellm-dev-key';
const LITELLM_MODEL = process.env.LITELLM_MODEL || 'atomic-agent';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}

export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LITELLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LITELLM_MODEL,
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
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LiteLLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeout);
  }
}
