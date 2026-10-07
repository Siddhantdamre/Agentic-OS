'use client';

import { useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Load a page ahead of time only when the person shows they are about to open it (hover, keyboard focus, a touch).
 * Next prefetches every visible link by default; for a sidebar of 25 links that was 21 requests and every other page's
 * code on every page load. Each page is asked for at most once.
 */
export function usePrefetchOnIntent(): (href: string) => void {
  const router = useRouter();
  const asked = useRef<Set<string>>(new Set());
  return useCallback(
    (href: string) => {
      if (asked.current.has(href)) return;
      asked.current.add(href);
      try {
        router.prefetch(href);
      } catch {
        /* a failed prefetch only means the page loads when it is opened */
      }
    },
    [router]
  );
}
