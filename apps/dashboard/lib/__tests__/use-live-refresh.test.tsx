import { act, renderHook } from '@testing-library/react';
import { useLiveRefresh } from '../use-live-refresh';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Set<(e: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
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
  close() {}
  emit(type: string) {
    const e = new MessageEvent(type, { data: JSON.stringify({}) });
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

describe('useLiveRefresh', () => {
  it('collapses an event burst into one refetch', async () => {
    const refetch = jest.fn().mockResolvedValue(undefined);
    renderHook(() => useLiveRefresh({ events: ['inquiry_updated'], refetch, debounceMs: 500 }));
    const es = FakeEventSource.instances[0];
    act(() => {
      es.emit('inquiry_updated');
      es.emit('inquiry_updated');
      es.emit('inquiry_updated');
    });
    expect(refetch).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('refetches on the polling tick while the stream is down', async () => {
    const refetch = jest.fn().mockResolvedValue(undefined);
    renderHook(() => useLiveRefresh({ events: ['inquiry_updated'], refetch }));
    act(() => FakeEventSource.instances[0].onerror?.());
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('skips a refetch while one is still running', async () => {
    let release: () => void = () => {};
    const refetch = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    renderHook(() => useLiveRefresh({ events: ['inquiry_updated'], refetch, debounceMs: 100 }));
    const es = FakeEventSource.instances[0];
    act(() => es.emit('inquiry_updated'));
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    act(() => es.emit('inquiry_updated'));
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
    });
    act(() => es.emit('inquiry_updated'));
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
