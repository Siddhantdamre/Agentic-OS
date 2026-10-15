'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, RefreshCw, XCircle, Minus, Square } from 'lucide-react';
import { ConnectorSignInControl } from '@/components/chat/ConnectorSignInLink';

export interface StepRunStatus {
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  message?: string;
  setupUrl?: string;
}

interface ExecutionStripProps {
  steps: Array<{ id: string; description: string }>;
  statuses: StepRunStatus[];
  running: boolean;
  onStop?: () => void;
}

export const ExecutionStrip: React.FC<ExecutionStripProps> = ({ steps, statuses, running, onStop }) => {
  const currentStepIdx = statuses.findIndex((s) => s.status === 'running');
  const completedCount = statuses.filter((s) => s.status === 'done' || s.status === 'error' || s.status === 'skipped').length;
  const activeStepNum = currentStepIdx >= 0 ? currentStepIdx + 1 : Math.min(completedCount + 1, steps.length);

  const isFullyComplete = !running && completedCount >= steps.length;
  const hasError = statuses.some((s) => s.status === 'error');

  const progressPercentage = Math.round((completedCount / (steps.length || 1)) * 100);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mt-3 mb-2 w-full bg-white border border-cream-200/90 rounded-2xl overflow-hidden shadow-xs font-sans"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-cream-200/80 bg-cream-50/70 flex-wrap gap-2">
        <div className="flex items-center space-x-2.5">
          {running ? (
            <RefreshCw className="w-4 h-4 text-amber-700 animate-spin shrink-0" />
          ) : isFullyComplete && !hasError ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
          )}
          <span className="font-semibold text-slate-800 text-xs tracking-tight">
            {running
              ? `Executing step ${activeStepNum} of ${steps.length}`
              : isFullyComplete && !hasError
              ? `All ${steps.length} tasks completed successfully`
              : `Execution completed with errors`}
          </span>
        </div>

        <div className="flex items-center space-x-3">
          {running && onStop && (
            <button
              type="button"
              onClick={onStop}
              className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 active:bg-rose-200 text-rose-700 font-semibold text-[11px] rounded-lg border border-rose-200/80 flex items-center space-x-1.5 transition-all shadow-xs cursor-pointer"
              title="Stop execution"
            >
              <Square className="w-2.5 h-2.5 fill-rose-600 text-rose-600" />
              <span>Stop</span>
            </button>
          )}

          <div className="w-28 h-1.5 bg-cream-200 rounded-full overflow-hidden border border-cream-300/50">
            <motion.div
              className={`h-full ${hasError ? 'bg-rose-500' : isFullyComplete ? 'bg-emerald-500' : 'bg-amber-500'}`}
              initial={{ width: 0 }}
              animate={{ width: `${progressPercentage}%` }}
              transition={{ duration: 0.4, ease: 'easeInOut' }}
            />
          </div>
          <span className="font-mono text-[10px] font-medium text-slate-500 w-8 text-right">
            {progressPercentage}%
          </span>
        </div>
      </div>

      {/* Step Status List */}
      <div className="p-2 space-y-1 bg-white">
        {steps.map((step, i) => {
          const st = statuses[i]?.status || 'pending';
          const isCurrent = st === 'running';

          return (
            <div
              key={step.id || i}
              className={`flex items-start justify-between px-3 py-2.5 rounded-xl transition-all ${
                isCurrent
                  ? 'bg-amber-50/70 border border-amber-300/60 shadow-xs'
                  : 'hover:bg-cream-50/60 border border-transparent'
              }`}
            >
              <div className="flex items-start space-x-3 min-w-0 flex-1 pr-3">
                <div className="pt-0.5 shrink-0">
                  {(() => {
                    switch (st) {
                      case 'done':
                        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />;
                      case 'running':
                        return <RefreshCw className="w-3.5 h-3.5 text-amber-700 animate-spin" />;
                      case 'error':
                        return <XCircle className="w-3.5 h-3.5 text-rose-600" />;
                      case 'skipped':
                        return <Minus className="w-3.5 h-3.5 text-slate-400" />;
                      case 'pending':
                        return <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-300/70" />;
                      default: {
                        const _exhaustive: never = st;
                        return _exhaustive;
                      }
                    }
                  })()}
                </div>

                <div className="space-y-1 min-w-0">
                  <div
                    className={`text-[12px] leading-snug ${
                      st === 'skipped'
                        ? 'text-slate-400 line-through'
                        : isCurrent
                        ? 'text-slate-900 font-semibold'
                        : st === 'done'
                        ? 'text-slate-700 font-medium'
                        : 'text-slate-500'
                    }`}
                  >
                    <span className="font-mono text-slate-400 mr-2 text-[10px]">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    {step.description}
                  </div>

                  {st === 'error' && statuses[i]?.message && (
                    <div className="text-[10px] text-rose-800 font-mono mt-1 bg-rose-50 p-2.5 rounded-lg border border-rose-200/80 break-words">
                      {statuses[i].message}
                      {statuses[i]?.setupUrl && (
                        <span className="block mt-1">
                          <ConnectorSignInControl
                            href={statuses[i].setupUrl}
                            idleLabel="Connect this tool"
                            className="text-amber-700 font-medium hover:text-amber-800 underline underline-offset-2"
                          />
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="shrink-0 pt-0.5">
                {st === 'done' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200/60">
                    Done
                  </span>
                )}
                {st === 'running' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100/90 text-amber-800 border border-amber-300/60 animate-pulse">
                    Running
                  </span>
                )}
                {st === 'error' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-rose-50 text-rose-700 border border-rose-200/60">
                    Failed
                  </span>
                )}
                {st === 'skipped' && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-50 text-slate-500 border border-slate-200/60">
                    Skipped
                  </span>
                )}
                {st === 'pending' && <span className="text-[10px] text-slate-400 px-1">Queued</span>}
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
};