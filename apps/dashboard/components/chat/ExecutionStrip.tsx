'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, RefreshCw, XCircle, Loader2, Minus } from 'lucide-react';

export interface StepRunStatus {
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  message?: string;
}

interface ExecutionStripProps {
  steps: Array<{ id: string; description: string }>;
  statuses: StepRunStatus[];
  running: boolean;
}

/**
 * Live execution progress for an approved plan: segmented amber bar + per-step
 * status chips. The bar fills proportionally to completed steps.
 */
export const ExecutionStrip: React.FC<ExecutionStripProps> = ({ steps, statuses, running }) => {
  const done = statuses.filter((s) => s.status === 'done' || s.status === 'error' || s.status === 'skipped').length;
  const pct = steps.length === 0 ? (running ? 5 : 0) : Math.round((done / steps.length) * 100);

  return (
    <div className="mt-3 w-full bg-white border border-amber-500/40 rounded-2xl p-5 space-y-4 text-xs shadow-lg">
      <div className="flex items-center justify-between">
        <span className="flex items-center space-x-2 font-bold text-heading">
          {running ? (
            <Loader2 className="w-4 h-4 text-amber-600 animate-spin" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          )}
          <span>{running ? 'Executing plan…' : 'Plan execution complete'}</span>
        </span>
        <span className="font-mono text-[11px] text-amber-700 bg-amber-500/10 rounded-full px-2.5 py-0.5">{pct}%</span>
      </div>

      {/* Segmented progress bar */}
      <div className="flex space-x-1">
        {steps.map((_, i) => {
          const st = statuses[i]?.status || 'pending';
          return (
            <motion.div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
                st === 'done' ? 'bg-emerald-500'
                : st === 'error' ? 'bg-red-500'
                : st === 'skipped' ? 'bg-cream-300'
                : st === 'running' ? 'bg-amber-500 animate-pulse'
                : 'bg-cream-200'
              }`}
            />
          );
        })}
      </div>

      {/* Step statuses */}
      <div className="space-y-1.5">
        {steps.map((step, i) => {
          const st = statuses[i]?.status || 'pending';
          return (
            <div key={step.id || i} className="flex items-center space-x-2 py-0.5">
              {st === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />}
              {st === 'running' && <RefreshCw className="w-3.5 h-3.5 text-amber-600 animate-spin shrink-0" />}
              {st === 'error' && <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
              {st === 'skipped' && <Minus className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
              {st === 'pending' && <span className="w-3.5 h-3.5 rounded-full bg-cream-300 shrink-0" />}
              <span className={`flex-1 text-[11px] ${st === 'error' ? 'text-red-600' : st === 'skipped' ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                {step.description}
              </span>
              {st === 'done' && <span className="text-[10px] text-emerald-600 font-bold">✓ Done</span>}
              {st === 'error' && <span className="text-[10px] text-red-500 font-bold">Failed</span>}
              {st === 'running' && <span className="text-[10px] text-amber-600 font-bold">Running…</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};