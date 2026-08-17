/**
 * Per-org rate limits (process-local). Burst webhooks and Ask AI must return
 * an honest 429 rather than exhausting the DB pool (max: 10) or throwing 500.
 *
 * Kinds:
 *   webhook            — sliding-window RPS after the org is resolved
 *   ask_ai             — sliding-window RPS for Ask AI mutating/stream routes
 *   ask_ai concurrency — in-flight Ask AI streams per org
 *   embed              — queued embed jobs per org (helper for later workers)
 *
 * Env (all optional; defaults are safe for a single dashboard replica):
 *   RATE_LIMIT_WEBHOOK_RPS
 *   RATE_LIMIT_ASK_AI_RPS
 *   RATE_LIMIT_ASK_AI_CONCURRENCY
 *   RATE_LIMIT_EMBED_QUEUE
 *
 * This is in-memory. Multi-replica limits need the Redis bus (I3) later.
 */

export type RateLimitKind = 'webhook' | 'ask_ai' | 'embed';
export type ConcurrencyKind = 'ask_ai' | 'embed';

export type RateLimitDecision =
  | { allowed: true; remaining: number; retryAfterSec: number }
  | { allowed: false; remaining: 0; retryAfterSec: number };

export class RateLimitError extends Error {
  readonly status = 429 as const;
  readonly retryAfterSec: number;

  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSec = Math.max(1, retryAfterSec);
  }
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError;
}

type WindowSpec = { max: number; windowMs: number };

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

function windowFor(kind: RateLimitKind): WindowSpec {
  switch (kind) {
    case 'webhook':
      return { max: envInt('RATE_LIMIT_WEBHOOK_RPS', 20), windowMs: 1000 };
    case 'ask_ai':
      return { max: envInt('RATE_LIMIT_ASK_AI_RPS', 8), windowMs: 1000 };
    case 'embed':
      return { max: envInt('RATE_LIMIT_EMBED_QUEUE', 32), windowMs: 60_000 };
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

function concurrencyCap(kind: ConcurrencyKind): number {
  switch (kind) {
    case 'ask_ai':
      return envInt('RATE_LIMIT_ASK_AI_CONCURRENCY', 3);
    case 'embed':
      return envInt('RATE_LIMIT_EMBED_QUEUE', 32);
    default: {
      const _never: never = kind;
      return _never;
    }
  }
}

const hits = new Map<string, number[]>();
const inFlight = new Map<string, number>();

function bucketKey(orgId: string, kind: string): string {
  return `${kind}:${orgId}`;
}

function prune(stamps: number[], windowStart: number): number[] {
  let i = 0;
  while (i < stamps.length && stamps[i] <= windowStart) i += 1;
  return i === 0 ? stamps : stamps.slice(i);
}

/**
 * Consume one request against the per-org sliding window. Call only after the
 * tenant is resolved from session / SECURITY DEFINER — never from body org_id.
 */
export function consumeOrgRateLimit(orgId: string, kind: RateLimitKind): RateLimitDecision {
  if (!orgId) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSec: 1 };
  }
  const { max, windowMs } = windowFor(kind);
  const now = Date.now();
  const key = bucketKey(orgId, kind);
  const stamps = prune(hits.get(key) || [], now - windowMs);
  if (stamps.length >= max) {
    hits.set(key, stamps);
    const oldest = stamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  stamps.push(now);
  hits.set(key, stamps);
  return { allowed: true, remaining: Math.max(0, max - stamps.length), retryAfterSec: 1 };
}

export function assertOrgRateLimit(orgId: string, kind: RateLimitKind, message: string): void {
  const decision = consumeOrgRateLimit(orgId, kind);
  if (!decision.allowed) {
    throw new RateLimitError(message, decision.retryAfterSec);
  }
}

export type ConcurrencyLease = { release: () => void };

/**
 * Try to take an in-flight slot. Caller MUST `release()` (prefer `finally`).
 * Returns null when the org is at the concurrency cap — respond 429, do not 500.
 */
export function tryAcquireConcurrency(orgId: string, kind: ConcurrencyKind): ConcurrencyLease | null {
  if (!orgId) {
    return { release: () => undefined };
  }
  const cap = concurrencyCap(kind);
  const key = bucketKey(orgId, `conc:${kind}`);
  const current = inFlight.get(key) || 0;
  if (current >= cap) return null;
  inFlight.set(key, current + 1);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const next = (inFlight.get(key) || 1) - 1;
      if (next <= 0) inFlight.delete(key);
      else inFlight.set(key, next);
    },
  };
}

export function tryReserveEmbedSlot(orgId: string): ConcurrencyLease | null {
  return tryAcquireConcurrency(orgId, 'embed');
}

export function rateLimitedResponse(retryAfterSec: number, message: string): Response {
  const retry = String(Math.max(1, retryAfterSec));
  return new Response(JSON.stringify({ error: message, retryable: true }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': retry,
    },
  });
}

export function responseFromRateLimit(err: RateLimitError): Response {
  return rateLimitedResponse(err.retryAfterSec, err.message);
}

/** Reusable helper: `null` means proceed; otherwise return this 429 Response. */
export function denyIfLimited(orgId: string, kind: RateLimitKind, message: string): Response | null {
  const decision = consumeOrgRateLimit(orgId, kind);
  if (decision.allowed) return null;
  return rateLimitedResponse(decision.retryAfterSec, message);
}

const WEBHOOK_429 = 'Too many webhook requests for this organization. Retry shortly.';
const ASK_AI_429 = 'Too many Ask AI requests for this organization. Retry shortly.';
const ASK_AI_BUSY = 'Ask AI is busy for this organization. Retry shortly.';

export function denyWebhookIfLimited(orgId: string): Response | null {
  return denyIfLimited(orgId, 'webhook', WEBHOOK_429);
}

export function denyAskAiIfLimited(orgId: string): Response | null {
  return denyIfLimited(orgId, 'ask_ai', ASK_AI_429);
}

export function denyAskAiBusy(): Response {
  return rateLimitedResponse(2, ASK_AI_BUSY);
}
