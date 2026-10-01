/**
 * Fence tool outputs before they re-enter the model context so indirect
 * prompt-injection strings cannot blend into agent instructions unmarked.
 */

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /disregard\s+(all\s+)?prior/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /system\s+prompt\s+override/i,
  /forward\s+(all\s+)?emails?\s+to/i,
];

const FENCE_OPEN = '<untrusted_tool_data>';
const FENCE_CLOSE = '</untrusted_tool_data>';

export function sanitizeToolOutput(rawOutput: string): string {
  let sanitized = String(rawOutput || '');
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      sanitized = sanitized.replace(pattern, '[SECURITY REDACTED: SUSPECTED PROMPT INJECTION]');
    }
  }
  return `\n${FENCE_OPEN}\n${sanitized}\n${FENCE_CLOSE}\n`;
}
