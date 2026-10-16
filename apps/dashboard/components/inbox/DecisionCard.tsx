'use client';

import React, { useState } from 'react';
import { AlertTriangle, Check, Clock } from 'lucide-react';

export const DECISION_REJECTION_REASONS = [
  { id: 'wrong_fit', label: 'Wrong fit' },
  { id: 'wrong_timing', label: 'Wrong timing' },
  { id: 'wrong_channel', label: 'Wrong channel' },
  { id: 'just_not_now', label: 'Just not now' },
] as const;

export type DecisionRejectionReason = (typeof DECISION_REJECTION_REASONS)[number]['id'];

export type DecisionCardOption = {
  id: string;
  label: string;
  cost: string;
};

export type DecisionCardPayload = {
  title?: string;
  customer?: string | { name?: string; identifier?: string };
  situation?: string;
  issue?: string;
  policy?: string;
  options: DecisionCardOption[];
  recommendation?: { optionId?: string; basis?: string; label?: string };
  recommendedAction?: { type?: string; humanText?: string };
  kind?: string;
};

export type DecisionAction = 'approve' | 'reject' | 'snooze' | 'modify';

type OwnerDecisionCardProps = {
  workItemId?: string;
  payload: DecisionCardPayload;
  disabled?: boolean;
  onDecision?: (
    action: DecisionAction,
    detail?: { optionId?: string; reason?: DecisionRejectionReason }
  ) => void | Promise<void>;
};

function customerLabel(customer: DecisionCardPayload['customer']): string {
  if (!customer) return '';
  if (typeof customer === 'string') return customer;
  return customer.name || customer.identifier || '';
}

export function OwnerDecisionCard({ workItemId, payload, disabled, onDecision }: OwnerDecisionCardProps) {
  const [phase, setPhase] = useState<'open' | 'reasons' | 'done'>('open');
  const [busy, setBusy] = useState(false);
  const [doneLabel, setDoneLabel] = useState('');

  const options = Array.isArray(payload.options) ? payload.options.filter((o) => o && o.label && o.cost) : [];
  const recId = payload.recommendation?.optionId || options[0]?.id;
  const rec = options.find((o) => o.id === recId) || options[0];
  const basis =
    payload.recommendation?.basis ||
    payload.recommendedAction?.humanText ||
    payload.policy ||
    '';
  const who = customerLabel(payload.customer);
  const situation = payload.situation || payload.issue || '';

  const finish = async (
    action: DecisionAction,
    detail?: { optionId?: string; reason?: DecisionRejectionReason }
  ) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await onDecision?.(action, detail);
      setDoneLabel(action === 'approve' ? 'Recorded' : action === 'snooze' ? 'Not now' : 'Passed');
      setPhase('done');
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'done') {
    return (
      <article className="bg-white border border-cream-300 rounded-2xl p-5 shadow-sm" data-work-item-id={workItemId}>
        <p className="text-sm font-semibold text-heading">{doneLabel}</p>
      </article>
    );
  }

  return (
    <article className="bg-white border border-cream-300 rounded-2xl shadow-sm overflow-hidden" data-work-item-id={workItemId}>
      <header className="flex items-start gap-3 px-5 py-4 border-b border-cream-200 bg-cream-100/60">
        <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-4 h-4 text-heading" />
        </div>
        <div>
          <h3 className="font-serif font-bold text-heading">{payload.title || rec?.label || 'Decision'}</h3>
          {who && <p className="text-xs text-slate-500 mt-0.5">{who}</p>}
        </div>
      </header>

      <div className="px-5 py-4 space-y-3 text-sm">
        {situation && <p className="text-heading leading-relaxed">{situation}</p>}

        <ul className="space-y-2">
          {options.map((option) => (
            <li key={option.id} className="rounded-xl border border-cream-200 bg-cream-50 px-3 py-2">
              <p className="font-semibold text-heading">{option.label}</p>
              <p className="text-xs text-slate-500 mt-0.5">{option.cost}</p>
            </li>
          ))}
        </ul>

        {rec && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-sm font-semibold text-heading">
              <Check className="w-3.5 h-3.5 inline mr-1" />
              Recommended: {payload.recommendation?.label || rec.label}
            </p>
            {basis && <p className="text-xs text-slate-600 mt-1">{basis}</p>}
          </div>
        )}
      </div>

      {phase === 'reasons' ? (
        <div className="px-5 pb-5 space-y-2">
          <p className="text-xs font-semibold text-heading">Not this one — why?</p>
          <div className="flex flex-wrap gap-2">
            {DECISION_REJECTION_REASONS.map((reason) => (
              <button
                key={reason.id}
                type="button"
                disabled={busy || disabled}
                onClick={() =>
                  finish(reason.id === 'just_not_now' ? 'snooze' : 'reject', { reason: reason.id })
                }
                className="px-3 py-1.5 text-xs font-semibold rounded-xl border border-cream-300 bg-white hover:bg-cream-100 text-heading disabled:opacity-50"
              >
                {reason.label}
              </button>
            ))}
          </div>
          <button type="button" className="text-[11px] text-slate-500 underline" onClick={() => finish('reject')}>
            Skip
          </button>
        </div>
      ) : (
        <div className="px-5 pb-5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || disabled || !rec}
            onClick={() => finish('approve', { optionId: rec?.id })}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-heading text-sm font-semibold rounded-xl disabled:opacity-50"
          >
            Do this
          </button>
          {options
            .filter((o) => o.id !== rec?.id)
            .map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={busy || disabled}
                onClick={() => finish('approve', { optionId: option.id })}
                className="px-4 py-2 bg-white border border-cream-300 hover:bg-cream-100 text-heading text-sm font-semibold rounded-xl disabled:opacity-50"
              >
                {option.label}
              </button>
            ))}
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => finish('snooze', { reason: 'just_not_now' })}
            className="px-4 py-2 bg-white border border-cream-300 hover:bg-cream-100 text-slate-600 text-sm font-semibold rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Clock className="w-3.5 h-3.5" />
            Not now
          </button>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => setPhase('reasons')}
            className="px-4 py-2 text-sm font-semibold text-slate-500 underline disabled:opacity-50"
          >
            Not this one
          </button>
        </div>
      )}
    </article>
  );
}

export const DecisionCard = OwnerDecisionCard;
