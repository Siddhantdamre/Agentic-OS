/**
 * @jest-environment node
 *
 * Ask AI forwards the prompt to a paid model and stores it. A fuzz run showed a 500 KB prompt accepted:
 * one request could spend a large share of a workspace's budget and hold that much in memory. The cap is
 * generous (a long pasted document fits) but finite, and an operator can move it with one setting.
 */
import { DEFAULT_ASK_AI_MAX_PROMPT_CHARS, askAiMaxPromptChars, askAiPromptTooLong } from '@/lib/ask-ai-limits';

describe('askAiMaxPromptChars', () => {
  it('defaults to 100,000 characters', () => {
    expect(DEFAULT_ASK_AI_MAX_PROMPT_CHARS).toBe(100_000);
    expect(askAiMaxPromptChars({})).toBe(100_000);
  });

  it('takes ASK_AI_MAX_PROMPT_CHARS when it is a positive whole number', () => {
    expect(askAiMaxPromptChars({ ASK_AI_MAX_PROMPT_CHARS: '20000' })).toBe(20_000);
  });

  it.each(['0', '-5', 'abc', '', '1.5', '  '])('ignores a bad setting (%p) and keeps the default', (v) => {
    expect(askAiMaxPromptChars({ ASK_AI_MAX_PROMPT_CHARS: v })).toBe(100_000);
  });
});

describe('askAiPromptTooLong', () => {
  it('accepts a prompt at the limit', () => {
    expect(askAiPromptTooLong('x'.repeat(100), 100)).toBeNull();
  });

  it('refuses one character over, and says what the limit is', () => {
    expect(askAiPromptTooLong('x'.repeat(101), 100)).toMatch(/100/);
  });

  it('refuses a 500 KB prompt at the default limit', () => {
    expect(askAiPromptTooLong('a'.repeat(500_000))).not.toBeNull();
  });

  it('accepts an ordinary question at the default limit', () => {
    expect(askAiPromptTooLong('What are your opening hours on Sunday?')).toBeNull();
  });
});
