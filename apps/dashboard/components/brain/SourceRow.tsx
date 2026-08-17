'use client';

import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';

export type BrainSourceView = {
  id: string;
  connector: string;
  path: string;
  status: string;
  lastSynced: string | null;
  disabled: boolean;
};

export function SourceRow({
  source,
  canMutate,
}: {
  source: BrainSourceView;
  canMutate: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reindex = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/brain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reindex', sourceId: source.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.enqueued) setNote('Reindex queued');
      else setNote(data.skipped ? `Skipped (${data.skipped})` : data.error || 'Could not reindex');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex items-center justify-between gap-3 bg-white border rounded-2xl p-4 ${
        source.disabled ? 'border-slate-300 opacity-70' : 'border-cream-300'
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-heading truncate">{source.connector}</span>
          <span
            className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
              source.disabled
                ? 'bg-slate-100 text-slate-600 border-slate-300'
                : 'bg-amber-50 text-amber-800 border-amber-200'
            }`}
          >
            {source.disabled ? 'disabled' : source.status}
          </span>
        </div>
        <p className="text-[11px] font-mono text-slate-500 truncate">{source.path}</p>
        {source.lastSynced && (
          <p className="text-[10px] font-mono text-slate-400">synced {source.lastSynced.slice(0, 10)}</p>
        )}
        {note && <p className="text-[10px] text-slate-500 mt-1">{note}</p>}
      </div>
      {canMutate && !source.disabled && (
        <button
          type="button"
          onClick={() => void reindex()}
          disabled={busy}
          className="shrink-0 px-3 py-1.5 text-[11px] font-bold rounded-lg bg-cream-100 border border-cream-300 text-heading hover:bg-amber-50 disabled:opacity-40 flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          Reindex
        </button>
      )}
    </div>
  );
}
