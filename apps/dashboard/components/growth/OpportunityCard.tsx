'use client';

import React, { useState } from 'react';
import { Building2, Send, Clock, X } from 'lucide-react';
import { networkErrorMessage } from '@/lib/client-error';

export const REJECTION_REASONS = [
  { id: 'wrong_fit', label: 'Wrong fit' },
  { id: 'wrong_timing', label: 'Wrong timing' },
  { id: 'wrong_channel', label: 'Wrong channel' },
  { id: 'just_not_now', label: 'Just not now' },
] as const;

export type RejectionReasonId = (typeof REJECTION_REASONS)[number]['id'];

export type GrowthOpportunityPayload = {
  companyName: string;
  icpScore?: number;
  whyThisCompany?: string;
  whyCompany?: string;
  targetContact?: { name: string; title?: string; email?: string; linkedin?: string };
  whyThisPerson?: string;
  whyPerson?: string;
  buyingSignals?: Array<{ type: string; summary: string; timestamp?: string }>;
  whyNow: string;
  draftedMessage?: { subject?: string; body?: string };
  summary?: string;
};

export type OpportunityDecision = 'approve' | 'reject' | 'snooze';

type OpportunityCardProps = {
  workItemId: string;
  payload: GrowthOpportunityPayload;
  disabled?: boolean;
  onDecision?: (decision: OpportunityDecision, reason?: RejectionReasonId) => void | Promise<void>;
};

export function OpportunityCard({ workItemId, payload, disabled, onDecision }: OpportunityCardProps) {
  const [phase, setPhase] = useState<'open' | 'reasons' | 'done'>('open');
  const [busy, setBusy] = useState(false);
  const [doneLabel, setDoneLabel] = useState('');
  const [error, setError] = useState('');

  const whyCompany = payload.whyThisCompany || payload.whyCompany || '';
  const whyPerson = payload.whyThisPerson || payload.whyPerson || '';
  const person = payload.targetContact?.name
    ? `${payload.targetContact.name}${payload.targetContact.title ? `, ${payload.targetContact.title}` : ''}`
    : 'this person';

  const finish = async (decision: OpportunityDecision, reason?: RejectionReasonId) => {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      await onDecision?.(decision, reason);
      setDoneLabel(
        decision === 'approve' ? 'Queued to send' : decision === 'snooze' ? 'Snoozed' : 'Passed'
      );
      setPhase('done');
    } catch (err) {
      setError(networkErrorMessage(err, 'We couldn’t save your decision. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'done') {
    return (
      <article className="bg-white border border-cream-300 rounded-2xl p-5 shadow-sm" data-work-item-id={workItemId}>
        <p className="text-sm font-semibold text-heading">{doneLabel}</p>
        <p className="text-xs text-slate-500 mt-1">{payload.companyName}</p>
      </article>
    );
  }

  return (
    <article className="bg-white border border-cream-300 rounded-2xl shadow-sm overflow-hidden" data-work-item-id={workItemId}>
      <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-cream-200 bg-cream-100/60">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
            <Building2 className="w-4 h-4 text-heading" />
          </div>
          <div>
            <h3 className="font-serif font-bold text-heading">{payload.companyName}</h3>
            <p className="text-xs text-slate-500 mt-0.5">{person}</p>
          </div>
        </div>
        {typeof payload.icpScore === 'number' && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            ICP {Math.round(payload.icpScore)}
          </span>
        )}
      </header>

      <div className="px-5 py-4 space-y-3 text-sm">
        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Why this company</h4>
          <p className="text-heading mt-1 leading-relaxed">{whyCompany}</p>
        </section>
        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Why this person</h4>
          <p className="text-heading mt-1 leading-relaxed">{whyPerson}</p>
        </section>
        <section>
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Why now</h4>
          <p className="text-heading mt-1 leading-relaxed">{payload.whyNow}</p>
        </section>
        {payload.draftedMessage?.body && (
          <section className="rounded-xl bg-cream-100 border border-cream-200 p-3">
            {payload.draftedMessage.subject && (
              <p className="text-xs font-semibold text-heading mb-1">{payload.draftedMessage.subject}</p>
            )}
            <p className="text-xs text-slate-600 whitespace-pre-wrap">{payload.draftedMessage.body}</p>
          </section>
        )}
      </div>

      {error && <p role="alert" className="px-5 pb-3 text-xs text-red-600">{error}</p>}

      {phase === 'reasons' ? (
        <div className="px-5 pb-5 space-y-2">
          <p className="text-xs font-semibold text-heading">Not this one — why?</p>
          <div className="flex flex-wrap gap-2">
            {REJECTION_REASONS.map((reason) => (
              <button
                key={reason.id}
                type="button"
                disabled={busy || disabled}
                onClick={() => finish(reason.id === 'just_not_now' ? 'snooze' : 'reject', reason.id)}
                className="px-3 py-1.5 text-xs font-semibold rounded-xl border border-cream-300 bg-white hover:bg-cream-100 text-heading disabled:opacity-50"
              >
                {reason.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="text-[11px] text-slate-500 underline"
            onClick={() => finish('reject')}
          >
            Skip
          </button>
        </div>
      ) : (
        <div className="px-5 pb-5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => finish('approve')}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-heading text-sm font-semibold rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            Send
          </button>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => setPhase('reasons')}
            className="px-4 py-2 bg-white border border-cream-300 hover:bg-cream-100 text-heading text-sm font-semibold rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" />
            Not this one
          </button>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => finish('snooze', 'just_not_now')}
            className="px-4 py-2 bg-white border border-cream-300 hover:bg-cream-100 text-slate-600 text-sm font-semibold rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Clock className="w-3.5 h-3.5" />
            Not now
          </button>
        </div>
      )}
    </article>
  );
}
