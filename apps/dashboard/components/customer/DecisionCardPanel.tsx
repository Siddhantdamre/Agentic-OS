'use client';

import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { networkErrorMessage } from '@/lib/client-error';
import { describeHeldAction, reasonText } from '@/lib/approval-view';

export type CustomerDecisionCard = {
  title?: string; customer?: string; situation?: string; policy?: string;
  /** Older cards carry plain text; a held action carries { optionId, basis } (the option picked and why). */
  recommendation?: string | { optionId?: string; basis?: string } | null;
  options?: Array<{ id: string; label: string; cost?: string }>;
  conversationId?: string | null;
  /** A held action also carries a sentence about what it would do, why it was held, and the call itself. */
  summary?: string;
  reasonCode?: string;
  payload?: Record<string, unknown> | null;
};

/** The recommendation in words, whatever shape it arrived in. Never an object: React cannot render one. */
function recommendationText(card: CustomerDecisionCard, options: Array<{ id: string; label: string }>): string | null {
  const rec = card.recommendation;
  if (typeof rec === 'string') return rec.trim() || null;
  if (rec && typeof rec === 'object' && typeof rec.optionId === 'string') {
    return options.find((o) => o.id === rec.optionId)?.label || null;
  }
  return null;
}

export function DecisionCardPanel({
  workItemId, card, conversationId, onResolved,
}: {
  workItemId: string;
  card: CustomerDecisionCard;
  conversationId?: string | null;
  onResolved?: (action: 'approve' | 'reject') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = Array.isArray(card.options) && card.options.length >= 2
    ? card.options
    : [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Hold' }];
  const convoId = conversationId || card.conversationId || null;
  const held = card.payload && typeof card.payload === 'object' && typeof (card.payload as Record<string, unknown>).tool === 'string'
    ? describeHeldAction({ id: workItemId, payload: { ...card.payload, summary: card.summary || card.title, reasonCode: card.reasonCode } })
    : null;
  const recommended = recommendationText(card, options);

  const decide = async (action: 'approve' | 'reject', optionId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/work-items/${workItemId}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, optionId: optionId || null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || 'Decision failed');
      }
      onResolved?.(action);
    } catch (err) {
      setError(networkErrorMessage(err, 'Decision failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="bg-white border border-cream-300 rounded-2xl p-4 space-y-3">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">Human attention required</p>
      <h3 className="font-serif font-bold text-heading">{card.title || card.summary || held?.title || 'Needs a decision'}</h3>
      {card.customer && <p className="text-sm text-slate-600">Customer: {card.customer}</p>}
      {card.situation && <p className="text-sm text-slate-700">{card.situation}</p>}
      {card.policy && <p className="text-xs text-slate-500">Policy: {card.policy}</p>}
      {held?.body && <p className="text-sm text-slate-700 whitespace-pre-wrap border-l-2 border-cream-300 pl-3">{held.body}</p>}
      {card.reasonCode && <p className="text-xs text-slate-500">{reasonText(card.reasonCode, held?.kind ?? 'other')}</p>}
      {recommended && <p className="text-sm font-medium text-heading">Recommended: {recommended}</p>}
      {convoId && (
        <a
          href={`/conversations?id=${convoId}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-semibold text-heading underline"
        >
          View full conversation <ExternalLink className="w-3 h-3" />
        </a>
      )}
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const action = option.id === 'reject' || option.id === 'hold' ? 'reject' : 'approve';
          return (
            <button
              key={option.id}
              type="button"
              disabled={busy}
              onClick={() => decide(action, option.id)}
              className="text-xs font-semibold px-3 py-2 rounded-xl border border-cream-300 bg-cream-100 text-heading disabled:opacity-50"
            >
              {option.label}{option.cost ? ` · ${option.cost}` : ''}
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-amber-800">{error}</p>}
    </article>
  );
}
