/** Longest Ask AI prompt accepted, in characters. About 25k tokens: a long pasted document fits. */
export const DEFAULT_ASK_AI_MAX_PROMPT_CHARS = 100_000;

/** ASK_AI_MAX_PROMPT_CHARS overrides the default when it is a positive whole number. */
export function askAiMaxPromptChars(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.ASK_AI_MAX_PROMPT_CHARS ?? '').trim();
  if (!/^\d+$/.test(raw)) return DEFAULT_ASK_AI_MAX_PROMPT_CHARS;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : DEFAULT_ASK_AI_MAX_PROMPT_CHARS;
}

/** A user-facing reason the prompt is refused for its size, or null when it is within the limit. */
export function askAiPromptTooLong(prompt: string, max: number = askAiMaxPromptChars()): string | null {
  if (prompt.length <= max) return null;
  return `Prompt is too long (${prompt.length.toLocaleString('en-US')} characters; the limit is ${max.toLocaleString('en-US')}). Shorten it or split it into parts.`;
}
