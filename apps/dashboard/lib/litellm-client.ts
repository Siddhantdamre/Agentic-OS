// Minimal OpenAI-compatible client for LiteLLM, used by the classify/plan/revise
// paths. These are plain chat completions that must return a single JSON object
// (or plain text) — they intentionally bypass the TrueForge agent loop, which
// would inject the full tool grammar and try to execute tools.

import { existsSync } from 'node:fs';

export function resolveLiteLLMConfig(): { baseUrl: string; apiKey: string; model: string } {
  const isProd = process.env.NODE_ENV === 'production';
  const isDocker = existsSync('/.dockerenv');
  let baseUrl =
    process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  const model = process.env.LITELLM_MODEL || 'darex-default';

  if (!baseUrl) {
    throw new Error('LITELLM_BASE_URL must be set');
  }
  if (!apiKey) {
    throw new Error('LITELLM_API_KEY or LITELLM_MASTER_KEY must be set');
  }

  baseUrl = baseUrl.replace(/\/$/, '');
  if (isDocker && (baseUrl.includes('localhost:4000') || baseUrl.includes('127.0.0.1:4000'))) {
    baseUrl = baseUrl.replace(/localhost:4000|127\.0\.0\.1:4000/, 'darex-litellm:4000');
  } else if (!isDocker && (baseUrl.includes('//litellm:4000') || baseUrl.includes('//darex-litellm:4000'))) {
    baseUrl = baseUrl.replace(/\/\/(litellm|darex-litellm):4000/, '//127.0.0.1:4000');
  }
  if (!baseUrl.endsWith('/v1')) {
    baseUrl = `${baseUrl}/v1`;
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
  /** Trusted org id: LiteLLM's Langfuse callback keys the trace by it so the
   *  llm_tokens meter (userId = orgId) counts this call. */
  orgId?: string;
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
          ...(options.orgId
            ? { user: options.orgId, metadata: { trace_user_id: options.orgId } }
            : {}),
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

  // Graceful fallback to direct provider if LiteLLM is down or unreachable
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${geminiKey}`,
        },
        body: JSON.stringify({
          model: process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash',
          messages,
          max_tokens: options.maxTokens,
          temperature: options.temperature ?? 0,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      });
      if (res.ok) {
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
      }
      const body = await res.text().catch(() => '');
      console.error(`Gemini fallback HTTP ${res.status}: ${body.slice(0, 300)}`);
    } catch (err) {
      console.error('Gemini fallback request failed', err);
    }
  }

  if (process.env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.GROQ_FALLBACK_MODEL || process.env.GROQ_CHAT_MODEL || 'qwen/qwen3.8-27b',
          messages,
          max_tokens: options.maxTokens,
          temperature: options.temperature ?? 0,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
      });
      if (res.ok) {
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
      }
      const body = await res.text().catch(() => '');
      console.error(`Groq fallback HTTP ${res.status}: ${body.slice(0, 300)}`);
    } catch (err) {
      console.error('Groq fallback request failed', err);
    }
  }

  throw lastError ?? new Error('LiteLLM request failed');
}


export type MediaInput = { kind: 'audio' | 'image'; mimeType: string; base64: string };

function audioFormat(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('aac')) return 'aac';
  if (m.includes('mp4') || m.includes('m4a')) return 'mp4';
  if (m.includes('flac')) return 'flac';
  return 'ogg';
}

/**
 * One multimodal completion (voice note or image). Not the agent loop: a single
 * call that returns text. Returns '' when the model gave nothing; throws on HTTP errors.
 */
export async function mediaCompletion(
  prompt: string,
  media: MediaInput,
  options: { maxTokens: number; timeoutMs?: number; orgId?: string }
): Promise<string> {
  const { baseUrl, apiKey, model } = resolveLiteLLMConfig();
  const part =
    media.kind === 'image'
      ? { type: 'image_url', image_url: { url: `data:${media.mimeType.split(';')[0]};base64,${media.base64}` } }
      : { type: 'input_audio', input_audio: { data: media.base64, format: audioFormat(media.mimeType) } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: options.maxTokens,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, part] }],
        ...(options.orgId ? { user: options.orgId, metadata: { trace_user_id: options.orgId } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LiteLLM HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}
