'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { ConfirmButton } from '@/components/a11y';
import { MIN_REASON_LENGTH } from './types';

export type ConfirmReasonDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  orgName?: string | null;
  orgId?: string | null;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  extraWarning?: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
};

/**
 * Required confirm gate for platform mutations: reason ≥ 12 chars,
 * explicit Confirm, and visible org name + id when provided.
 */
export function ConfirmReasonDialog({
  open,
  title,
  description,
  orgName,
  orgId,
  confirmLabel = 'Confirm',
  danger = false,
  busy = false,
  extraWarning,
  onCancel,
  onConfirm,
}: ConfirmReasonDialogProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  if (!open) return null;

  const trimmed = reason.trim();
  const valid = trimmed.length >= MIN_REASON_LENGTH;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-heading/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="platform-confirm-title"
    >
      <div className="w-full max-w-md bg-white border border-cream-300 rounded-3xl shadow-xl p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              id="platform-confirm-title"
              className="text-lg font-serif font-bold text-heading"
            >
              {title}
            </h2>
            {description ? (
              <p className="text-sm text-slate-500 mt-1">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="p-1.5 rounded-xl text-slate-400 hover:text-heading hover:bg-cream-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {(orgName || orgId) && (
          <div className="rounded-2xl border border-cream-300 bg-cream-50 p-3 text-xs space-y-1">
            {orgName ? (
              <p>
                <span className="font-bold text-slate-500 uppercase tracking-wider">Org</span>{' '}
                <span className="font-semibold text-heading">{orgName}</span>
              </p>
            ) : null}
            {orgId ? (
              <p className="font-mono text-[11px] text-slate-600 break-all">{orgId}</p>
            ) : null}
          </div>
        )}

        {extraWarning ? (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{extraWarning}</span>
          </div>
        ) : null}

        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Reason (min {MIN_REASON_LENGTH} characters)
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={busy}
            className="w-full px-3 py-2.5 bg-cream-100 border border-cream-300 rounded-xl text-sm text-heading focus:outline-none focus:border-amber-500 resize-y min-h-[80px]"
            placeholder="Why is this action needed?"
          />
          <span className="text-[11px] text-slate-500">
            {trimmed.length}/{MIN_REASON_LENGTH} minimum
          </span>
        </label>

        <div className="flex items-center justify-end gap-2 pt-1">
          <ConfirmButton
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-xs font-semibold text-slate-500 hover:text-heading rounded-xl"
          >
            Cancel
          </ConfirmButton>
          <ConfirmButton
            onClick={() => void onConfirm(trimmed)}
            disabled={busy || !valid}
            className={`px-5 py-2.5 text-xs font-bold rounded-xl shadow-sm ${
              danger
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-amber-500 hover:bg-amber-600 text-heading'
            }`}
          >
            {busy ? 'Working…' : confirmLabel}
          </ConfirmButton>
        </div>
      </div>
    </div>
  );
}
