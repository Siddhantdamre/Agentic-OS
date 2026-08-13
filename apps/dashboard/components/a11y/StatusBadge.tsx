'use client';

import React from 'react';
import {
  CheckCircle2,
  CircleDashed,
  AlertTriangle,
  PauseCircle,
  XCircle,
  Clock,
  Plug,
  PlugZap,
} from 'lucide-react';

export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'pending';

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-emerald-500/10 text-emerald-800 border-emerald-500/30',
  warning: 'bg-amber-500/10 text-amber-900 border-amber-500/30',
  danger: 'bg-red-50 text-red-800 border-red-200',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
  info: 'bg-sky-50 text-sky-800 border-sky-200',
  pending: 'bg-cream-200 text-slate-700 border-cream-300',
};

const TONE_ICON: Record<StatusTone, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  neutral: CircleDashed,
  info: PlugZap,
  pending: Clock,
};

interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
  icon?: 'check' | 'warn' | 'pause' | 'error' | 'clock' | 'plug' | 'connected' | 'none';
  className?: string;
}

/**
 * Status that is never color-only: icon + text, plus a tone class.
 */
export function StatusBadge({ label, tone = 'neutral', icon, className = '' }: StatusBadgeProps) {
  const Icon =
    icon === 'none'
      ? null
      : icon === 'pause'
        ? PauseCircle
        : icon === 'plug'
          ? Plug
          : icon === 'connected'
            ? PlugZap
            : TONE_ICON[tone];

  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${TONE_CLASS[tone]} ${className}`}
    >
      {Icon ? <Icon className="w-3 h-3 shrink-0" aria-hidden="true" /> : null}
      <span>{label}</span>
    </span>
  );
}
