'use client';

import React, { useState } from 'react';
import { X, BookOpen, Sparkles } from 'lucide-react';
import { networkErrorMessage } from '@/lib/client-error';

export function TeachKnowledgeGapModal({
  cluster,
  onClose,
  onSaved,
}: {
  cluster: { topic: string; count: number } | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!cluster) return null;

  const save = async () => {
    if (!answer.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/brain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: `FAQ: ${cluster.topic}`.slice(0, 200),
          body: answer.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === 'string' ? data.error : 'Failed to save');
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError(networkErrorMessage(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto bg-white border border-cream-300 rounded-2xl p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-serif font-bold text-heading flex items-center gap-2">
            <BookOpen className="w-5 h-5" /> Teach AI answer
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-heading" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-3 bg-cream-100 rounded-xl border border-cream-200">
          <p className="text-xs uppercase tracking-wider text-slate-500">Frequent question</p>
          <p className="text-sm font-medium text-heading mt-1">{cluster.topic}</p>
          <p className="text-xs text-amber-700 mt-1">Asked {cluster.count} times without a grounded answer</p>
        </div>
        <textarea
          rows={4}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Canonical answer to store in org knowledge…"
          className="w-full px-3 py-2 border border-cream-300 rounded-xl text-sm text-heading focus:outline-none focus:border-amber-500"
        />
        {error && <p className="text-xs text-amber-800">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs text-slate-500">
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || !answer.trim()}
            onClick={save}
            className="px-4 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-heading rounded-xl disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : 'Save to knowledge'}
          </button>
        </div>
      </div>
    </div>
  );
}
