/**
 * Returns the normalized URL when it is an absolute http(s) URL, else null.
 * Use before storing or rendering any user/provider-supplied link so
 * `javascript:`, `data:`, `vbscript:` and relative tricks never reach an href.
 */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}
