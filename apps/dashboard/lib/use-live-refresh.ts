'use client';

import { useEffect, useRef } from 'react';
import type { RealtimeEventType } from '@darex/shared-types';
import { useRealtimeStream } from '@/lib/use-realtime-stream';

type Options = {
  events: readonly RealtimeEventType[];
  /** Quiet refetch: must not flip the page into its loading state. */
  refetch: () => void | Promise<void>;
  /** Bursts of events collapse into one refetch after this delay. */
  debounceMs?: number;
  fallbackMs?: number;
  enabled?: boolean;
};

/**
 * Cross-tab live refresh on top of `useRealtimeStream`: a matching bus
 * event triggers one debounced quiet refetch, and while the stream is down
 * the polling tick refetches instead. Never refetches while one is running.
 */
export function useLiveRefresh({
  events,
  refetch,
  debounceMs = 600,
  fallbackMs,
  enabled = true,
}: Options): { fallback: boolean } {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = () => {
    if (inflight.current) return;
    inflight.current = true;
    void Promise.resolve()
      .then(() => refetchRef.current())
      .catch((err: unknown) => console.error('[live-refresh] refetch failed', err))
      .finally(() => {
        inflight.current = false;
      });
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return useRealtimeStream({
    events,
    enabled,
    fallbackMs,
    onEvent: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        run();
      }, debounceMs);
    },
    onFallbackTick: run,
  });
}
