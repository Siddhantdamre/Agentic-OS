'use client';

import { useEffect, useRef, useState } from 'react';
import type { RealtimeEventType } from '@darex/shared-types';

export type RealtimeEventPayload = {
  type: RealtimeEventType;
  orgId?: string;
  conversationId?: string;
  message?: string;
  contactId?: string | null;
  channelType?: string;
  ts?: number;
  eventId?: string;
};

type Options = {
  /** Bus event types to listen for. Only types in REALTIME_EVENT_TYPES compile. */
  events: readonly RealtimeEventType[];
  onEvent: (payload: RealtimeEventPayload) => void;
  /** Called every `fallbackMs` while the stream is down, so the page can poll. */
  onFallbackTick?: () => void;
  fallbackMs?: number;
  enabled?: boolean;
};

const STREAM_URL = '/api/stream/events';

/**
 * The one client for `/api/stream/events`. Closes the stream while the tab
 * is hidden, reconnects with 1.5^n backoff plus jitter (max 30 s), and
 * reports `fallback` while disconnected so the page can show a banner and
 * poll through `onFallbackTick`.
 */
export function useRealtimeStream({
  events,
  onEvent,
  onFallbackTick,
  fallbackMs = 5000,
  enabled = true,
}: Options): { fallback: boolean } {
  const [fallback, setFallback] = useState(false);
  const onEventRef = useRef(onEvent);
  const onTickRef = useRef(onFallbackTick);
  onEventRef.current = onEvent;
  onTickRef.current = onFallbackTick;
  const eventKey = events.join('|');

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const types = eventKey ? (eventKey.split('|') as RealtimeEventType[]) : [];
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    const listener = (e: MessageEvent) => {
      let payload: RealtimeEventPayload;
      try {
        payload = JSON.parse(e.data) as RealtimeEventPayload;
      } catch (err) {
        console.error('[realtime] unparseable event', err);
        return;
      }
      onEventRef.current({ ...payload, type: e.type as RealtimeEventType });
    };

    const startFallback = () => {
      setFallback(true);
      if (pollTimer) return;
      pollTimer = setInterval(() => onTickRef.current?.(), fallbackMs);
    };

    const stopFallback = () => {
      setFallback(false);
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const close = () => {
      if (!es) return;
      for (const t of types) es.removeEventListener(t, listener as EventListener);
      es.close();
      es = null;
    };

    const connect = () => {
      if (disposed || document.hidden) return;
      close();
      const source = new EventSource(STREAM_URL);
      es = source;
      for (const t of types) source.addEventListener(t, listener as EventListener);
      source.onopen = () => {
        attempts = 0;
        stopFallback();
      };
      source.onerror = () => {
        close();
        startFallback();
        attempts += 1;
        const backoff = Math.min(1000 * Math.pow(1.5, attempts), 30000);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, backoff + Math.random() * 2000);
      };
    };

    const onVisibility = () => {
      if (document.hidden) {
        close();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
      } else if (!es) {
        connect();
      }
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (pollTimer) clearInterval(pollTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      close();
    };
  }, [enabled, eventKey, fallbackMs]);

  return { fallback };
}
