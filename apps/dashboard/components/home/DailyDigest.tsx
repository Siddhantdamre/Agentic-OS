'use client';

import React, { useEffect, useState } from 'react';
import { responseErrorMessage, networkErrorMessage } from '@/lib/client-error';

interface DigestPayload {
  headline: string;
  lines: string[];
  quiet: boolean;
  savedNote: string;
}

/** What happened in the last 24 hours and what needs the owner. Quiet days stay short; a failure says so. */
export function DailyDigest() {
  const [digest, setDigest] = useState<DigestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/digest');
        if (!res.ok) throw new Error(await responseErrorMessage(res, 'Could not load today’s summary.'));
        const body = (await res.json()) as { digest?: DigestPayload };
        if (!cancelled && body.digest) setDigest(body.digest);
      } catch (err) {
        if (!cancelled) setError(networkErrorMessage(err, 'Could not load today’s summary.'));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return <p role="status" className="rounded-2xl border border-border bg-white px-4 py-3 text-sm text-body">{error}</p>;
  }
  if (!digest) return null;
  return (
    <section aria-labelledby="digest-title" className="rounded-2xl border border-border bg-white px-4 py-4">
      <h2 id="digest-title" className="text-sm font-bold text-heading">Today so far</h2>
      <p className="mt-1 text-sm text-body">{digest.headline}</p>
      {digest.lines.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm text-body">
          {digest.lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      {digest.savedNote && <p className="mt-2 text-xs text-muted">{digest.savedNote}</p>}
    </section>
  );
}
