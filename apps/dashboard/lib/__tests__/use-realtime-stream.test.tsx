import { act, renderHook } from '@testing-library/react';
import { useRealtimeStream } from '../use-realtime-stream';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    const e = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (global as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useRealtimeStream', () => {
  it('delivers only the subscribed event types with their type', () => {
    const onEvent = jest.fn();
    renderHook(() =>
      useRealtimeStream({ events: ['needs_attention', 'conversation_takeover_updated'], onEvent })
    );
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe('/api/stream/events');
    act(() => {
      es.emit('conversation_takeover_updated', { conversationId: 'c1' });
      es.emit('message_received', { conversationId: 'c2' });
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      type: 'conversation_takeover_updated',
      conversationId: 'c1',
    });
  });

  it('falls back to polling on error, reconnects, and stops polling on open', () => {
    const tick = jest.fn();
    const { result } = renderHook(() =>
      useRealtimeStream({ events: ['needs_attention'], onEvent: jest.fn(), onFallbackTick: tick })
    );
    act(() => FakeEventSource.instances[0].onerror?.());
    expect(result.current.fallback).toBe(true);
    expect(FakeEventSource.instances[0].closed).toBe(true);

    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(tick).toHaveBeenCalled();
    expect(FakeEventSource.instances.length).toBe(2);

    act(() => FakeEventSource.instances[1].onopen?.());
    expect(result.current.fallback).toBe(false);
    const calls = tick.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(tick.mock.calls.length).toBe(calls);
  });

  it('closes the stream on unmount', () => {
    const { unmount } = renderHook(() =>
      useRealtimeStream({ events: ['needs_attention'], onEvent: jest.fn() })
    );
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });
});
