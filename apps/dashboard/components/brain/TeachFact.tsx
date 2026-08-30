'use client';

/**
 * TYPE A FACT.
 *
 * Until this existed, the only way to teach the agent anything was to upload a
 * file. For a broker who knows their brokerage is 2% that is the difference
 * between a thirty-second action and a task that never happens — and it showed:
 * 719 conversations answered, and every fact behind them came from pack
 * defaults or an uploaded document. Nobody had ever told it anything directly.
 *
 * Saved at priority 100, the value migration 026 defines as "human correction",
 * so a person stating a fact outranks a PDF that contradicts it — the same rule
 * an operator's reply edit already gets.
 *
 * THE RECEIPT IS THE POINT. Teaching something and getting no acknowledgement
 * feels like shouting into a void, so you do it once and conclude the thing
 * does not listen. The response says what was learned, in the agent's voice.
 */

import React, { useState } from 'react';
import { Lightbulb, Check } from 'lucide-react';

const KINDS = [
  { id: 'faq', label: 'Answer to a question' },
  { id: 'policy', label: 'A rule or policy' },
  { id: 'sop', label: 'How something is done' },
] as const;

export function TeachFact({ onSaved }: { onSaved?: () => void }) {
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string>('faq');
  const [saving, setSaving] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || saving) return;
    setSaving(true);
    setError(null);
    setReceipt(null);
    try {
      const res = await fetch('/api/brain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-fact', title, body, kind }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not save that.');
      setReceipt(json.message);
      setBody('');
      setTitle('');
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white border border-cream-300 rounded-2xl p-5">
      <div className="flex items-start gap-2 mb-3">
        <Lightbulb className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <div>
          <h2 className="text-sm font-bold text-heading">Tell it something</h2>
          <p className="text-xs text-slate-500 mt-1">
            Type a fact in your own words. No file needed. What you write here beats
            anything a document says.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <textarea
          value={body}
          onChange={(e) => { setBody(e.target.value); setReceipt(null); }}
          rows={3}
          maxLength={4000}
          placeholder="Our brokerage is 2% of sale value, payable on registration."
          className="w-full px-4 py-3 rounded-xl bg-cream-100 border border-cream-300 text-sm text-heading placeholder:text-slate-400 focus:outline-none focus:border-amber-500 resize-y"
        />

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder="Label (optional)"
            className="flex-1 min-w-[10rem] px-3 py-2 rounded-xl bg-cream-100 border border-cream-300 text-xs text-heading placeholder:text-slate-400 focus:outline-none focus:border-amber-500"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="What kind of thing is this"
            className="px-3 py-2 rounded-xl bg-cream-100 border border-cream-300 text-xs text-heading focus:outline-none focus:border-amber-500"
          >
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <button
            type="submit"
            disabled={!body.trim() || saving}
            className="px-4 py-2 rounded-xl bg-amber-600 text-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1"
          >
            {saving ? 'Saving…' : 'Teach it'}
          </button>
        </div>
      </form>

      {receipt && (
        <p
          role="status"
          className="mt-3 flex items-start gap-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2"
        >
          <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {receipt}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-800 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
          {error}
        </p>
      )}
    </section>
  );
}
