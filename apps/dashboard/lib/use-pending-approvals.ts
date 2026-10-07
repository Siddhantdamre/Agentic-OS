'use client';

import { useCallback, useEffect, useState } from 'react';
import { APPROVALS_CHANGED_EVENT } from '@/lib/approvals-client';

const POLL_MS = 30_000;

/**
 * How many approvals are waiting, for the sidebar badge. It asks for the number alone (one cheap count), checks again
 * every half minute while the tab is visible, and at once when an approval is decided on this page. When it cannot
 * reach the server it returns null: no badge, never a wrong "0".
 */
export function usePendingApprovalCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/decisions?count=1');
      if (!res.ok) return setCount(null);
      const data = (await res.json()) as { pending?: unknown };
      setCount(typeof data.pending === 'number' ? data.pending : null);
    } catch {
      setCount(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh();
    }, POLL_MS);
    const onChanged = () => void refresh();
    window.addEventListener(APPROVALS_CHANGED_EVENT, onChanged);
    return () => {
      clearInterval(timer);
      window.removeEventListener(APPROVALS_CHANGED_EVENT, onChanged);
    };
  }, [refresh]);

  return count;
}
