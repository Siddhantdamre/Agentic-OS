'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLiveRefresh } from '@/lib/use-live-refresh';
import { AlertTriangle, Check, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { ExplainDrawer } from '@/components/explain/ExplainDrawer';
import { LiveRegion } from '@/components/a11y';
import { networkErrorMessage } from '@/lib/client-error';
import { ApprovalsCallout } from '@/components/home/ApprovalsCallout';
import { usePendingApprovalCount } from '@/lib/use-pending-approvals';

type BriefException = {
  id: string;
  title: string;
  detail: string;
  status: string;
  deviation?: string | null;
};

type MorningBrief = {
  exceptions: BriefException[];
  handledOvernight: number;
  totalOpen?: number;
  truncated?: boolean;
  handledWindowLabel?: string;
};

const BRIEF_EVENTS = [
  'needs_attention',
  'conversation_updated',
  'plan_updated',
  'work_item_updated',
] as const;

export default function BriefPage() {
  const approvalsWaiting = usePendingApprovalCount() ?? 0;
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const res = await fetch(`/api/brief?tz=${encodeURIComponent(tz)}&limit=40`);
      if (!res.ok) throw new Error('We couldn’t load brief. Please try again.');
      const data = await res.json();
      setBrief({
        exceptions: Array.isArray(data.exceptions) ? data.exceptions : [],
        handledOvernight: Number(data.handledOvernight || 0),
        totalOpen: typeof data.totalOpen === 'number' ? data.totalOpen : undefined,
        truncated: Boolean(data.truncated),
        handledWindowLabel:
          typeof data.handledWindowLabel === 'string' ? data.handledWindowLabel : undefined,
      });
      if (quiet) setError(null);
    } catch (err: unknown) {
      // A failed background refresh keeps the last good brief on screen.
      if (quiet) console.error('[brief] live refresh failed', err);
      else setError(networkErrorMessage(err, 'Failed to load brief'));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh({ events: BRIEF_EVENTS, refetch: () => load(true) });

  const triage = async (id: string, action: 'approve' | 'snooze' | 'dismiss') => {
    setActingId(id);
    try {
      const res = await fetch(`/api/brief/${encodeURIComponent(id)}/triage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : `Failed to ${action}`);
        return;
      }
      setBrief((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          exceptions: prev.exceptions.filter((e) => e.id !== id),
          handledOvernight:
            action === 'approve' || action === 'dismiss'
              ? prev.handledOvernight + 1
              : prev.handledOvernight,
          totalOpen: typeof prev.totalOpen === 'number' ? Math.max(0, prev.totalOpen - 1) : prev.totalOpen,
        };
      });
    } catch (err) {
      setError(networkErrorMessage(err, `We couldn’t ${action} that. Please try again.`));
    } finally {
      setActingId(null);
    }
  };

  const exceptions = brief?.exceptions || [];
  const handled = brief?.handledOvernight || 0;
  // Approvals waiting are something that needs the person, whatever the exception list says.
  const empty = !loading && exceptions.length === 0 && approvalsWaiting === 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <LiveRegion message={empty ? `Nothing needs you. ${handled} things handled.` : ''} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">Morning brief</h1>
          <p className="text-slate-500 text-sm mt-1">Exceptions only. Handled work stays in the log.</p>
        </div>
        <ExplainDrawer defaultQuery="" />
      </div>

      <ApprovalsCallout />

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
      )}

      {brief?.truncated && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          Showing {exceptions.length} of {brief.totalOpen ?? 'many'} open exceptions — list is paginated.
        </p>
      )}

      {loading ? (
        <div className="h-32 bg-cream-200/50 rounded-2xl animate-pulse border border-cream-300" />
      ) : empty ? (
        <div className="bg-white border border-cream-300 rounded-3xl p-10 text-center space-y-2">
          <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" />
          <h2 className="text-lg font-serif font-bold text-heading">Nothing needs you.</h2>
          <p className="text-sm text-slate-500">{handled} things handled.</p>
        </div>
      ) : exceptions.length === 0 ? null : (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-heading">
            {exceptions.length} {exceptions.length === 1 ? 'thing needs' : 'things need'} you.
          </p>
          {exceptions.map((item) => (
            <article key={item.id} className="bg-white border border-cream-300 rounded-2xl p-4 shadow-sm">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-heading text-sm">{item.title}</h3>
                  <p className="text-xs text-slate-600 mt-1">{item.detail}</p>
                  {item.deviation && (
                    <p className="text-[11px] font-semibold text-amber-700 mt-1">{item.deviation}</p>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={actingId === item.id}
                      onClick={() => void triage(item.id, 'dismiss')}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg border border-cream-300 text-slate-600 hover:bg-cream-100 disabled:opacity-40"
                    >
                      <XCircle className="w-3.5 h-3.5" /> Dismiss
                    </button>
                    <button
                      type="button"
                      disabled={actingId === item.id}
                      onClick={() => void triage(item.id, 'snooze')}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg border border-cream-300 text-slate-700 hover:bg-cream-100 disabled:opacity-40"
                    >
                      <Clock className="w-3.5 h-3.5" /> Snooze 2h
                    </button>
                    <button
                      type="button"
                      disabled={actingId === item.id}
                      onClick={() => void triage(item.id, 'approve')}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
                    >
                      <Check className="w-3.5 h-3.5" /> Approve
                    </button>
                  </div>
                </div>
                <ExplainDrawer objectId={item.id} defaultQuery={item.title} />
              </div>
            </article>
          ))}
        </div>
      )}

      {!loading && handled > 0 && (
        <p className="text-xs text-slate-500">
          Handled {brief?.handledWindowLabel || 'overnight'}: {handled}.
        </p>
      )}
    </div>
  );
}
