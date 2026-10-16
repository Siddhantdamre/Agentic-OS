'use client';

import React, { useState } from 'react';
import { Check, Clock, Mail, MessageSquare, CalendarDays, Wallet, FileText, ShieldQuestion } from 'lucide-react';
import type { ApprovalKind, ApprovalView } from '@/lib/approval-view';
import type { Outcome } from '@/lib/approvals-client';

const KIND: Record<ApprovalKind, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  email: { label: 'Email', Icon: Mail },
  message: { label: 'Message', Icon: MessageSquare },
  calendar: { label: 'Calendar', Icon: CalendarDays },
  payment: { label: 'Payment', Icon: Wallet },
  refund: { label: 'Refund', Icon: Wallet },
  record: { label: 'Record', Icon: FileText },
  other: { label: 'Action', Icon: ShieldQuestion },
};

const TONE: Record<Outcome['tone'], string> = {
  done: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  waiting: 'bg-amber-50 text-amber-900 border-amber-200',
  failed: 'bg-red-50 text-red-900 border-red-200',
};

export function ApprovalCard({
  view, focused, selectable, selected, outcome, busy, editableKey, onSelect, onDecide, onFocus,
}: {
  view: ApprovalView;
  focused: boolean;
  selectable: boolean;
  selected: boolean;
  outcome: Outcome | null;
  busy: boolean;
  /** The argument holding the message text, when the person may edit it before it goes out. */
  editableKey: string | null;
  onSelect: (id: string, on: boolean) => void;
  onDecide: (view: ApprovalView, decision: 'approved' | 'rejected', editedBody?: string) => void;
  onFocus: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.body ?? '');
  const { Icon, label } = KIND[view.kind];

  return (
    <article
      data-approval-id={view.id}
      onClick={() => onFocus(view.id)}
      className={`rounded-2xl border bg-white p-5 space-y-3 shadow-sm ${focused ? 'border-amber-500 ring-2 ring-amber-200' : 'border-cream-300'}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
        {selectable && !outcome ? (
          <input
            type="checkbox"
            aria-label={`Select: ${view.title}`}
            checked={selected}
            onChange={(e) => onSelect(view.id, e.target.checked)}
            className="h-4 w-4 accent-amber-500"
          />
        ) : null}
        <span className="inline-flex items-center gap-1 rounded-full bg-cream-100 px-2 py-0.5 font-semibold text-heading">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </span>
        <span className="font-semibold text-heading">{view.who}</span>
        {view.ageText ? <span aria-hidden="true">·</span> : null}
        {view.ageText ? <span>{view.ageText}</span> : null}
        {view.expiresText ? (
          <span className="inline-flex items-center gap-1 ml-auto">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {view.expiresText}
          </span>
        ) : null}
      </div>

      <h3 className="font-serif text-lg text-heading leading-snug">{view.title}</h3>

      {view.details.length > 0 ? (
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
          {view.details.map((d) => (
            <React.Fragment key={d.label}>
              <dt className="text-slate-500">{d.label}</dt>
              <dd className="text-heading break-words">{d.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}

      {editing ? (
        <div className="space-y-2">
          <label htmlFor={`edit-${view.id}`} className="block text-xs font-semibold text-slate-600">Message</label>
          <textarea
            id={`edit-${view.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            className="w-full rounded-xl border border-cream-300 bg-cream-100/40 p-3 text-sm text-heading focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          />
        </div>
      ) : view.body ? (
        <p className="whitespace-pre-wrap border-l-2 border-cream-300 pl-3 text-sm text-slate-700">{view.body}</p>
      ) : null}

      <p className="flex items-start gap-1.5 text-xs text-slate-500">
        <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{view.whyHeld}</span>
      </p>
      {view.needsText ? <p className="text-xs font-semibold text-amber-800">{view.needsText}</p> : null}
      {view.finalNote ? <p className="text-xs font-semibold text-slate-700">{view.finalNote}</p> : null}

      {outcome ? (
        <p role="status" className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium ${TONE[outcome.tone]}`}>
          {outcome.tone === 'done' ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
          <span>{outcome.text}</span>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1">
          {editing ? (
            <>
              <button
                type="button"
                disabled={busy || !draft.trim()}
                onClick={() => onDecide(view, 'approved', draft)}
                className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-heading disabled:opacity-50"
              >
                Approve with changes
              </button>
              <button type="button" onClick={() => { setEditing(false); setDraft(view.body ?? ''); }} className="rounded-xl bg-cream-200 px-4 py-2 text-xs font-bold text-heading">
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => onDecide(view, 'approved')} className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-heading disabled:opacity-50">
                Approve
              </button>
              {editableKey ? (
                <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded-xl border border-cream-300 bg-white px-4 py-2 text-xs font-bold text-heading disabled:opacity-50">
                  Edit
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => onDecide(view, 'rejected')} className="rounded-xl bg-cream-200 px-4 py-2 text-xs font-bold text-heading disabled:opacity-50">
                Reject
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
