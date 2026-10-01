'use client';

import React, { useState } from 'react';
import { HelpCircle, X } from 'lucide-react';

type ExplainMatch = {
  actionConsidered?: string;
  decision?: string;
  reasonSummary?: string;
  createdAt?: string;
};

type ExplainResponse = {
  answer?: string;
  remedy?: string | null;
  matches?: ExplainMatch[];
  source?: string;
};

type ExplainDrawerProps = {
  objectId?: string;
  defaultQuery?: string;
};

export function ExplainDrawer({ objectId, defaultQuery = '' }: ExplainDrawerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(defaultQuery);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExplainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (objectId) params.set('objectId', objectId);
      const res = await fetch(`/api/agent/explain?${params.toString()}`);
      if (!res.ok) throw new Error(`Explain failed (${res.status})`);
      const data = (await res.json()) as ExplainResponse;
      setResult(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Explain failed');
    } finally {
      setLoading(false);
    }
  };

  const openDrawer = () => {
    setOpen(true);
    if (!result) void run(q || defaultQuery);
  };

  return (
    <>
      <button
        type="button"
        onClick={openDrawer}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-heading"
      >
        <HelpCircle className="w-3.5 h-3.5" />
        Why?
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/20" role="dialog" aria-label="Explain">
          <div className="w-full max-w-md h-full bg-cream-100 border-l border-cream-300 shadow-xl p-5 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-serif font-bold text-heading">What has the employee done here?</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="p-1 rounded-lg hover:bg-cream-200">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form
              className="flex gap-2 mb-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(q);
              }}
            >
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="why didn't you chase…"
                className="flex-1 rounded-xl border border-cream-300 bg-white px-3 py-2 text-sm"
              />
              <button type="submit" className="px-3 py-2 rounded-xl bg-amber-500 text-heading text-sm font-semibold">
                Ask
              </button>
            </form>
            {loading && <p className="text-sm text-slate-500">Looking in the ledger…</p>}
            {error && <p className="text-sm text-red-700">{error}</p>}
            {result && (
              <div className="space-y-3">
                <p className="text-sm text-heading leading-relaxed">{result.answer}</p>
                {result.remedy && (
                  <p className="text-xs text-slate-600">{result.remedy}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
