type Bucket = {
  tokens: number;
  capacity: number;
  refillPerSec: number;
  updatedAt: number;
};

const buckets = new Map<string, Bucket>();

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function providerEnvKey(provider: string): string {
  return String(provider || 'unknown')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}

function bucketFor(orgId: string, provider: string): Bucket {
  const key = `${orgId}::${provider.toLowerCase()}`;
  const existing = buckets.get(key);
  if (existing) return existing;
  const envKey = providerEnvKey(provider);
  const created: Bucket = {
    tokens: envNumber(`RATE_LIMIT_${envKey}_CAPACITY`, 20),
    capacity: envNumber(`RATE_LIMIT_${envKey}_CAPACITY`, 20),
    refillPerSec: envNumber(`RATE_LIMIT_${envKey}_REFILL`, 2),
    updatedAt: Date.now(),
  };
  buckets.set(key, created);
  return created;
}

function takeToken(orgId: string, provider: string): { allowed: boolean; retryAfterMs: number } {
  const bucket = bucketFor(orgId, provider);
  const now = Date.now();
  const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedSec * bucket.refillPerSec);
  bucket.updatedAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }
  const need = 1 - bucket.tokens;
  const retryAfterMs = Math.ceil((need / bucket.refillPerSec) * 1000);
  return { allowed: false, retryAfterMs };
}

export function fullJitterBackoffMs(attempt: number, baseMs = 250, capMs = 8_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(Math.random() * exp);
}

export function isRetryableProviderError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = Number((err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode);
  if (status === 429 || status === 503) return true;
  const message = err instanceof Error ? err.message : String((err as { message?: string }).message || '');
  return /\b429\b|\b503\b|too many requests|rate limit|service unavailable/i.test(message);
}

export async function withProviderRateLimit<T>(
  orgId: string,
  provider: string,
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number }
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const gate = takeToken(orgId, provider);
    if (!gate.allowed) {
      await new Promise((resolve) => setTimeout(resolve, gate.retryAfterMs + fullJitterBackoffMs(attempt)));
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableProviderError(err) || attempt === maxAttempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, fullJitterBackoffMs(attempt)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('provider rate limit exhausted');
}
