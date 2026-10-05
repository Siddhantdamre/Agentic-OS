'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

type ReadyCheck = { status?: string; detail?: string };
type ReadyPayload = {
  status?: string;
  checks?: Record<string, ReadyCheck>;
};

const POLL_MS = 30_000;

/**
 * Polls /api/health/ready and surfaces real degradation only.
 * Healthy / not_configured deps do not show a banner.
 */
export function SystemDegradationBanner() {
  const [message, setMessage] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkHealth() {
      try {
        const res = await fetch('/api/health/ready', { cache: 'no-store' });
        const data = (await res.json()) as ReadyPayload;
        if (cancelled) return;

        if (data.status === 'unhealthy') {
          setMessage('We’re having trouble reaching some of our systems. Some actions may not work for a few minutes — we’ll keep trying.');
          setDismissed(false);
          return;
        }

        if (data.status === 'degraded') {
          setMessage('Some background features are running slowly right now. Chatting and your data are still available.');
          return;
        }

        setMessage(null);
        setDismissed(false);
      } catch {
        if (cancelled) return;
        // Network blip only — do not invent an outage list.
        setMessage('We can’t reach the service right now. Retrying…');
      }
    }

    checkHealth();
    const timer = setInterval(checkHealth, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!message || dismissed) return null;

  return (
    <div
      role="status"
      className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-900 flex items-center justify-between gap-3"
    >
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
        <span className="truncate">{message}</span>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="touch-target text-amber-700 hover:text-amber-900 p-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        aria-label="Dismiss status banner"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
