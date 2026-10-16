/**
 * How many queries may one workspace have running at once?
 *
 * WHY THIS EXISTS
 * The worker's database pool has ten connections and every tenant shares it. A
 * statement timeout bounds how long ONE query can hold a connection, but not how
 * many a single workspace can hold at the same time. Measured: with 12% of a
 * concurrent load being runaway queries, every request queued behind them and
 * median latency for ordinary queries rose to the length of the timeout. A
 * prompt-injected agent that fires ten runaway queries at once takes the SQL
 * tool away from every other tenant for as long as it keeps doing so.
 *
 * The cap is per workspace and in-process (each worker has its own pool, so an
 * in-process count is the right scope). It fails fast with a message the model
 * can act on instead of queueing, because a queue is just the same starvation
 * with a longer fuse.
 *
 * Deliberately not a rate limit: a workspace running queries one after another
 * as fast as the database answers is behaving normally. Only concurrency
 * occupies a scarce shared resource.
 */
export class OrgLimiter {
  private readonly inflight = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** A release function if there is room, otherwise null. Release is idempotent. */
  tryAcquire(orgId: string): (() => void) | null {
    const n = this.inflight.get(orgId) ?? 0;
    if (n >= this.max) return null;
    this.inflight.set(orgId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.inflight.get(orgId) ?? 0;
      if (cur <= 1) this.inflight.delete(orgId);
      else this.inflight.set(orgId, cur - 1);
    };
  }

  /** For tests and diagnostics. */
  active(orgId: string): number {
    return this.inflight.get(orgId) ?? 0;
  }
}
