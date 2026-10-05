/**
 * A lazy, shared, fail-fast connection getter.
 *
 * Every request that wants Temporal used to wait the full connect timeout (5 s) whenever the cluster was
 * down, because each call started a fresh attempt: a restart or outage turned every such request into a
 * 5-second hang before the direct fallback ran. Here one attempt is shared by concurrent callers, a success
 * is cached for good, and after a failure the answer is `null` immediately for `backoffMs`, so one request
 * pays the wait and the rest fall back at once.
 */
export interface LazyConnectorOptions<C> {
  /** Open the connection. May hang; `timeoutMs` bounds it. */
  connect: () => Promise<C>;
  timeoutMs: number;
  /** After a failure, answer null at once for this long before trying again. */
  backoffMs: number;
  now?: () => number;
  onConnected?: (client: C) => void;
  onFailure?: (err: Error) => void;
}

export function createLazyConnector<C>(opts: LazyConnectorOptions<C>): () => Promise<C | null> {
  const now = opts.now ?? Date.now;
  let client: C | null = null;
  let inflight: Promise<C | null> | null = null;
  let retryAfter = 0;

  return async function getClient(): Promise<C | null> {
    if (client) return client;
    if (inflight) return inflight;
    if (now() < retryAfter) return null;

    inflight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const attempt = opts.connect();
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`connect timed out after ${opts.timeoutMs} ms`));
          }, opts.timeoutMs);
        });
        const connected = await Promise.race([attempt, timeout]);
        client = connected;
        opts.onConnected?.(connected);
        return connected;
      } catch (err) {
        // A connect that completes after we gave up is discarded, never cached, never an unhandled rejection.
        if (timedOut) attempt.catch(() => undefined);
        retryAfter = now() + opts.backoffMs;
        opts.onFailure?.(err instanceof Error ? err : new Error(String(err)));
        return null;
      } finally {
        if (timer) clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  };
}
