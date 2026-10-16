'use client';

import React, { useEffect, useState } from 'react';
import { X, CheckCircle, Clock, ExternalLink } from 'lucide-react';
import { networkErrorMessage } from '@/lib/client-error';

type OpenLoop = {
  id: string;
  promiseSummary: string;
  dueDate: string | null;
  status: string;
  customerIdentifier: string;
  conversationId: string | null;
  channel: string | null;
  contactId: string | null;
};

export function OpenLoopsDrawer({
  isOpen,
  onClose,
  onUpdated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onUpdated?: () => void;
}) {
  const [loops, setLoops] = useState<OpenLoop[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/employees/customer/open-loops');
        if (!res.ok) throw new Error('We couldn’t load this list. Please try again.');
        const data = await res.json();
        if (!cancelled) {
          setLoops(Array.isArray(data.openLoops) ? data.openLoops : []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(networkErrorMessage(err, 'We couldn’t load this list. Please try again.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const resolve = async (loopId: string) => {
    try {
      const res = await fetch('/api/employees/customer/open-loops', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loopId, status: 'fulfilled' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data.error === 'string' ? data.error : 'We couldn’t update that. Please try again.');
        return;
      }
      setLoops((prev) => prev.filter((l) => l.id !== loopId));
      onUpdated?.();
    } catch (err) {
      setError(networkErrorMessage(err, 'We couldn’t update that. Please try again.'));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end">
      <div className="w-full max-w-lg bg-white border-l border-cream-300 p-6 shadow-xl flex flex-col">
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-cream-200">
          <div>
            <h2 className="text-lg font-serif font-bold text-heading flex items-center gap-2">
              <Clock className="w-5 h-5" /> Open customer commitments
            </h2>
            <p className="text-xs text-slate-500 mt-1">Promises extracted from conversations — real rows only.</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-heading" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 space-y-3 overflow-y-auto flex-1">
          {loading ? (
            <p className="text-sm text-slate-500 text-center py-8">Loading…</p>
          ) : error ? (
            <p className="text-sm text-amber-800">{error}</p>
          ) : loops.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <CheckCircle className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
              No open commitments.
            </div>
          ) : (
            loops.map((loop) => (
              <article key={loop.id} className="p-4 border border-cream-300 rounded-xl space-y-2">
                <p className="text-xs text-slate-500">
                  {loop.customerIdentifier}
                  {loop.channel ? ` · ${loop.channel}` : ''}
                </p>
                <p className="text-sm text-heading">{loop.promiseSummary}</p>
                <div className="flex items-center justify-between pt-2 border-t border-cream-200 text-xs">
                  {loop.conversationId ? (
                    <a
                      href={`/conversations?id=${loop.conversationId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-heading underline inline-flex items-center gap-1"
                    >
                      View chat <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span className="text-slate-400">No conversation link</span>
                  )}
                  <button
                    type="button"
                    onClick={() => resolve(loop.id)}
                    className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-heading rounded-lg font-semibold"
                  >
                    Mark fulfilled
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
