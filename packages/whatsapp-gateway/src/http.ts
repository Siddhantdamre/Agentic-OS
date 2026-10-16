export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Retries 5xx and 429 with backoff; other statuses return at once. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = 15000,
  attempts = 3
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetchWithTimeout(url, init, timeoutMs);
    if (last.ok || (last.status < 500 && last.status !== 429)) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)));
  }
  return last!;
}

export function metaString(meta: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!meta) return null;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
