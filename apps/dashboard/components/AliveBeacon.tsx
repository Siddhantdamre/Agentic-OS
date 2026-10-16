'use client';

import { useEffect } from 'react';
import { LOAD_GUARD_BANNER_ID } from '@/lib/load-guard';

/** Marks the page alive once React has taken over, and clears the load warning if a slow start already raised it. */
export function AliveBeacon() {
  useEffect(() => {
    (window as unknown as { __darexAlive?: boolean }).__darexAlive = true;
    document.getElementById(LOAD_GUARD_BANNER_ID)?.remove();
  }, []);
  return null;
}
