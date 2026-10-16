/**
 * A heartbeat for background work. Each activity the worker runs leaves a small mark per workspace: it finished, or
 * it failed and how. The dashboard reads those marks to say whether an AI employee's background checks are running.
 *
 * Rules that keep this safe:
 *  - it only watches: the activity's result and its original error pass through unchanged;
 *  - a recorder that fails is swallowed, so a database hiccup never breaks real work;
 *  - successes are written at most once a minute per workspace and activity, so a busy sweep adds almost no writes;
 *  - the stored error text drops e-mail addresses and long digit runs, so no customer detail lands in a health row.
 */
import type { ActivityInboundCallsInterceptor, ActivityInboundCallsInterceptorFactory } from '@temporalio/worker';

export interface HealthRecord {
  orgId: string;
  activity: string;
  ok: boolean;
  error: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OK_EVERY_MS = 60_000;
const FAIL_EVERY_MS = 5_000;
const MAX_ERROR = 200;

export function orgIdFromArgs(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'string') return UUID.test(first) ? first : null;
  if (first && typeof first === 'object') {
    const o = first as Record<string, unknown>;
    for (const key of ['orgId', 'org_id']) {
      const v = o[key];
      if (typeof v === 'string' && UUID.test(v)) return v;
    }
  }
  return null;
}

export function safeErrorText(err: unknown): string {
  const name = err instanceof Error && err.name ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  const text = `${name}: ${message}`
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/\d{7,}/g, '[number]')
    .replace(/\s+/g, ' ');
  return text.length > MAX_ERROR ? text.slice(0, MAX_ERROR) : text;
}

export function activityHealthInterceptor(
  record: (r: HealthRecord) => void | Promise<void>,
  clock: () => number = Date.now,
): ActivityInboundCallsInterceptorFactory {
  const lastWritten = new Map<string, number>();

  const write = (r: HealthRecord) => {
    const key = `${r.orgId}|${r.activity}|${r.ok ? 'ok' : 'fail'}`;
    const now = clock();
    const prev = lastWritten.get(key);
    if (prev !== undefined && now - prev < (r.ok ? OK_EVERY_MS : FAIL_EVERY_MS)) return;
    lastWritten.set(key, now);
    try {
      void Promise.resolve(record(r)).catch(() => undefined);
    } catch {
      /* a broken recorder must never break the activity */
    }
  };

  return (ctx): ActivityInboundCallsInterceptor => ({
    async execute(input, next) {
      const activity = ctx.info.activityType;
      const orgId = orgIdFromArgs(input.args as unknown[]);
      try {
        const out = await next(input);
        if (orgId) write({ orgId, activity, ok: true, error: null });
        return out;
      } catch (err) {
        if (orgId) write({ orgId, activity, ok: false, error: safeErrorText(err) });
        throw err;
      }
    },
  });
}
