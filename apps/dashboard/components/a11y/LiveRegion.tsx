'use client';

import React from 'react';

type LivePoliteness = 'polite' | 'assertive' | 'off';

interface LiveRegionProps {
  message: string;
  politeness?: LivePoliteness;
  atomic?: boolean;
  className?: string;
}

/**
 * Screen-reader live region. Visible text is optional; the message is always
 * announced. Use for stream status, warmup, and confirm outcomes.
 */
export function LiveRegion({
  message,
  politeness = 'polite',
  atomic = true,
  className,
}: LiveRegionProps) {
  return (
    <div
      role="status"
      aria-live={politeness}
      aria-atomic={atomic}
      className={className ?? 'sr-only'}
    >
      {message}
    </div>
  );
}
