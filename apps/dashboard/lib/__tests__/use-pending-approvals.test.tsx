import { renderHook, act, waitFor } from '@testing-library/react';
import { usePendingApprovalCount } from '../use-pending-approvals';
import { APPROVALS_CHANGED_EVENT } from '../approvals-client';

let count = 3;
let fail = false;
const urls: string[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  count = 3; fail = false; urls.length = 0;
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    if (fail) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ pending: count }) } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => { jest.useRealTimers(); });

describe('usePendingApprovalCount', () => {
  it('asks for the count alone, not the list', async () => {
    const { result } = renderHook(() => usePendingApprovalCount());
    await waitFor(() => expect(result.current).toBe(3));
    expect(urls).toEqual(['/api/decisions?count=1']);
  });

  it('updates at once when an approval is decided anywhere on the page', async () => {
    const { result } = renderHook(() => usePendingApprovalCount());
    await waitFor(() => expect(result.current).toBe(3));
    count = 2;
    act(() => { window.dispatchEvent(new Event(APPROVALS_CHANGED_EVENT)); });
    await waitFor(() => expect(result.current).toBe(2));
  });

  it('checks again every half minute while the tab is open, so a new request shows up without a reload', async () => {
    const { result } = renderHook(() => usePendingApprovalCount());
    await waitFor(() => expect(result.current).toBe(3));
    count = 5;
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await waitFor(() => expect(result.current).toBe(5));
  });

  it('shows no number rather than a wrong zero when it cannot reach the server', async () => {
    fail = true;
    const { result } = renderHook(() => usePendingApprovalCount());
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBeNull();
  });

  it('stops checking when the page is closed', async () => {
    const { result, unmount } = renderHook(() => usePendingApprovalCount());
    await waitFor(() => expect(result.current).toBe(3));
    unmount();
    const before = urls.length;
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(urls.length).toBe(before);
  });
});
