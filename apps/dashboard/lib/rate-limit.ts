/**
 * Per-org rate limits. Burst webhooks and Ask AI must return an honest 429
 * rather than exhausting the DB pool (max: 10) or throwing 500.
 *
 * Ask AI prefers Redis (`REDIS_URL`, same Nango redis as the SSE bus) with a
 * fixed-window INCR. When Redis is unset or unreachable the helper fails open
 * to the process-local sliding window — never invent a second limiter API.
 *
 * In-memory helpers live in `rate-limit-core.ts` (Edge-safe; middleware imports
 * that module directly). This file re-exports them and adds Redis for Node.
 *
 * Env (optional):
 *   RATE_LIMIT_WEBHOOK_RPS, RATE_LIMIT_ASK_AI_RPS, RATE_LIMIT_ASK_AI_CONCURRENCY
 *   RATE_LIMIT_EMBED_QUEUE, DAREX_ORG_RATE_LIMIT_PER_MINUTE, REDIS_URL
 */
import { createConnection } from 'net';
import { connect as tlsConnect } from 'tls';
import {
  ASK_AI_429,
  denyIfLimited,
  rateLimitedResponse,
  windowFor,
  type RateLimitDecision,
} from './rate-limit-core';

export {
  RateLimitError,
  assertOrgRateLimit,
  clientIpFromRequest,
  consumeIpRateLimit,
  consumeOrgRateLimit,
  denyAskAiBusy,
  denyAskAiIfLimited,
  denyAuthIfLimited,
  denyIfLimited,
  denyOrgApiIfLimited,
  denyWebhookIfLimited,
  isRateLimitError,
  rateLimitedResponse,
  responseFromRateLimit,
  tryAcquireConcurrency,
  tryReserveEmbedSlot,
  type ConcurrencyKind,
  type ConcurrencyLease,
  type RateLimitDecision,
  type RateLimitKind,
} from './rate-limit-core';

function redisUrlForLimits(): string | null {
  const url = process.env.REDIS_URL?.trim() || '';
  if (!url) return null;
  if (/langfuse-redis/i.test(url)) return null;
  return url;
}

/**
 * Fixed-window counter over Redis. Returns null when Redis is not configured
 * or the command fails — callers must fall back to the in-memory helper.
 */
async function redisFixedWindowConsume(
  bucket: string,
  max: number,
  windowMs: number
): Promise<RateLimitDecision | null> {
  const urlString = redisUrlForLimits();
  if (!urlString) return null;

  try {
    const url = new URL(urlString);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') return null;
    const host = url.hostname || '127.0.0.1';
    const port = url.port ? Number(url.port) : 6379;
    const password = decodeURIComponent(url.password || '');
    const useTls = url.protocol === 'rediss:';
    const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
    const slot = Math.floor(Date.now() / windowMs);
    const key = `rl:ask_ai:${bucket}:${slot}`;

    const reply = await new Promise<string>((resolve, reject) => {
      const socket = useTls
        ? tlsConnect({ host, port, servername: host, rejectUnauthorized: true })
        : createConnection({ host, port });
      let settled = false;
      const finish = (err?: Error, data?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(data || '');
      };
      socket.setTimeout(1500);
      socket.on('timeout', () => finish(new Error('redis rate-limit timeout')));
      socket.on('error', (err) => finish(err));
      socket.on('connect', () => {
        const parts: string[] = [];
        if (password) {
          parts.push(`*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(password)}\r\n${password}\r\n`);
        }
        // MULTI / INCR / EXPIRE / EXEC
        parts.push('*1\r\n$5\r\nMULTI\r\n');
        parts.push(`*2\r\n$4\r\nINCR\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`);
        const expArgs = `${windowSec}`;
        parts.push(
          `*3\r\n$6\r\nEXPIRE\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n$${Buffer.byteLength(expArgs)}\r\n${expArgs}\r\n`
        );
        parts.push('*1\r\n$4\r\nEXEC\r\n');
        socket.write(parts.join(''));
      });
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('-ERR') || buf.includes('-NOAUTH')) {
          finish(new Error('redis rate-limit auth/command failed'));
          return;
        }
        // EXEC array reply ends with the INCR integer on its own line after :N
        const incrMatch = buf.match(/\*2\r\n:(\d+)\r\n:(\d+)\r\n/);
        if (incrMatch) {
          finish(undefined, incrMatch[1]);
        }
      });
    });

    const count = parseInt(reply, 10);
    if (!Number.isFinite(count)) return null;
    if (count > max) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(windowMs / 1000)) };
    }
    return { allowed: true, remaining: Math.max(0, max - count), retryAfterSec: 1 };
  } catch {
    return null;
  }
}

/**
 * Ask AI limiter: Redis when available, otherwise the existing in-memory window.
 * Pass session orgId and userId — never a body org_id.
 */
export async function denyAskAiIfLimitedAsync(
  orgId: string,
  userId?: string
): Promise<Response | null> {
  if (!orgId) return null;
  const bucket = userId ? `${orgId}:u:${userId}` : orgId;
  const { max, windowMs } = windowFor('ask_ai');
  const redisDecision = await redisFixedWindowConsume(bucket, max, windowMs);
  if (redisDecision) {
    if (redisDecision.allowed) return null;
    return rateLimitedResponse(redisDecision.retryAfterSec, ASK_AI_429);
  }
  // Fail open to process-local helper when Redis is unset or unreachable.
  return denyIfLimited(bucket, 'ask_ai', ASK_AI_429);
}
