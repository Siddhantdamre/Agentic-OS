'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { ConfirmButton } from '@/components/a11y';
import { ConfirmReasonDialog } from './ConfirmReasonDialog';
import { endImpersonation, fetchImpersonationCurrent } from './api';
import type { ImpersonationCurrent } from './types';

const POLL_MS = 60_000;

/**
 * Persistent banner when the current session is an open impersonation target.
 * Honest empty: missing table / 404 / inactive → render nothing.
 */
export function ImpersonationBanner() {
  const [session, setSession] = useState<ImpersonationCurrent | null>(null);
  const [ending, setEnding] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const current = await fetchImpersonationCurrent();
    setSession(current.active ? current : null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await fetchImpersonationCurrent();
      if (!cancelled) setSession(current.active ? current : null);
    })();
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  if (!session?.active) return null;

  const endsAt = session.expiresAt
    ? new Date(session.expiresAt).toLocaleString()
    : 'unknown';
  const who =
    session.actorEmail ||
    (session.actorUserId ? `user ${session.actorUserId.slice(0, 8)}…` : 'a platform operator');

  return (
    <>
      <div
        role="alert"
        className="bg-red-50 border-b border-red-200 px-4 py-2.5 text-xs text-red-900 flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex items-start gap-2 min-w-0">
          <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-semibold">
              Impersonation active — {who} is acting as this account.
            </p>
            <p className="text-red-800/90">
              Ends {endsAt}. All actions during this session are logged.
              {session.breakGlass ? ' Break-glass access.' : ''}
            </p>
            {error ? <p className="text-red-700">{error}</p> : null}
          </div>
        </div>
        <ConfirmButton
          onClick={() => {
            setError(null);
            setConfirmOpen(true);
          }}
          disabled={ending}
          className="shrink-0 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl"
        >
          End impersonation
        </ConfirmButton>
      </div>

      <ConfirmReasonDialog
        open={confirmOpen}
        title="End impersonation"
        description="This ends the impersonation session and increments the target user's session epoch."
        orgId={session.targetOrgId}
        confirmLabel="End session"
        danger
        busy={ending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={async (reason) => {
          setEnding(true);
          setError(null);
          const result = await endImpersonation(reason);
          setEnding(false);
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          setConfirmOpen(false);
          setSession(null);
          window.location.href = '/admin';
        }}
      />
    </>
  );
}
