'use client';

import React, { useState } from 'react';
import { AlertTriangle, Pencil, Trash2 } from 'lucide-react';

export type BrainSnippetView = {
  id: string;
  tier: string;
  title: string | null;
  snippet: string;
  source: string;
  stale: boolean;
  updatedAt: string;
};

export function SnippetCard({
  snippet,
  canMutate,
  onDeleted,
  onCorrected,
}: {
  snippet: BrainSnippetView;
  canMutate: boolean;
  onDeleted: (id: string) => void;
  onCorrected: (id: string, body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(snippet.snippet);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/brain/${encodeURIComponent(snippet.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'correct', body: draft.trim() }),
      });
      if (res.ok) {
        onCorrected(snippet.id, draft.trim());
        setEditing(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/brain/${encodeURIComponent(snippet.id)}`, { method: 'DELETE' });
      if (res.ok) onDeleted(snippet.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white border border-cream-300 rounded-2xl p-4 space-y-2 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-md bg-cream-100 text-slate-600 border border-cream-300">
            {snippet.tier}
          </span>
          <span className="text-[10px] font-mono text-slate-500 truncate">{snippet.source}</span>
          {snippet.stale && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              stale
            </span>
          )}
        </div>
        {canMutate && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="p-1.5 rounded-lg text-slate-500 hover:text-heading hover:bg-cream-100"
              aria-label="Correct memory"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="p-1.5 rounded-lg text-slate-500 hover:text-red-700 hover:bg-red-50 disabled:opacity-40"
              aria-label="Delete memory"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
      {snippet.title && <p className="text-xs font-semibold text-heading">{snippet.title}</p>}
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full text-xs p-2 rounded-xl border border-cream-300 focus:border-amber-500 focus:outline-none min-h-[72px]"
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !draft.trim()}
            className="px-3 py-1.5 text-[11px] font-bold rounded-lg bg-amber-500 text-heading disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-700 leading-relaxed">{snippet.snippet}</p>
      )}
      {snippet.updatedAt && (
        <p className="text-[10px] font-mono text-slate-400">{snippet.updatedAt.slice(0, 10)}</p>
      )}
    </div>
  );
}
