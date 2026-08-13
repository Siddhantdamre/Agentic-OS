'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, RefreshCw, XCircle, Minus } from 'lucide-react';

export interface StepRunStatus {
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  message?: string;
  setupUrl?: string;
}

interface ExecutionStripProps {
  steps: Array<{ id: string; description: string }>;
  statuses: StepRunStatus[];
  running: boolean;
}

export const ExecutionStrip: React.FC<ExecutionStripProps> = ({ steps, statuses, running }) => {
  const currentStepIdx = statuses.findIndex((s) => s.status === 'running');
  const completedCount = statuses.filter((s) => s.status === 'done' || s.status === 'error' || s.status === 'skipped').length;
  const activeStepNum = currentStepIdx >= 0 ? currentStepIdx + 1 : Math.min(completedCount + 1, steps.length);

  const isFullyComplete = !running && completedCount >= steps.length;
  const hasError = statuses.some(s => s.status === 'error');

  const progressPercentage = Math.round((completedCount / (steps.length || 1)) * 100);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mt-4 w-full bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm font-sans"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-950/50">
        <div className="flex items-center space-x-2.5">
          {running ? (
            <RefreshCw className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
          ) : isFullyComplete ? (
             <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 text-red-400 shrink-0" />
          )}
          <span className="font-semibold text-slate-200 text-xs">
            {running ? `Executing step ${activeStepNum} of ${steps.length}` : 
             isFullyComplete && !hasError ? `Execution completed successfully` : 
             `Execution finished with errors`}
          </span>
        </div>
        
        <div className="flex items-center space-x-3">
          <div className="w-32 h-1.5 bg-slate-800 rounded-full overflow-hidden">
            <motion.div 
              className={`h-full ${hasError ? 'bg-red-500' : 'bg-blue-500'}`}
              initial={{ width: 0 }}
              animate={{ width: `${progressPercentage}%` }}
              transition={{ duration: 0.5, ease: 'easeInOut' }}
            />
          </div>
          <span className="font-mono text-[10px] font-medium text-slate-400 w-8 text-right">
            {progressPercentage}%
          </span>
        </div>
      </div>

      {/* Step Status List */}
      <div className="p-2 space-y-1 bg-slate-900">
        {steps.map((step, i) => {
          const st = statuses[i]?.status || 'pending';
          return (
            <div 
              key={step.id || i} 
              className={`flex items-start justify-between px-3 py-2 rounded-xl transition-colors ${
                st === 'running' ? 'bg-slate-800/80' : 'hover:bg-slate-800/40'
              }`}
            >
              <div className="flex items-start space-x-3 min-w-0 flex-1 pr-4">
                <div className="pt-0.5 shrink-0">
                  {(() => {
                    switch (st) {
                      case 'done':
                        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
                      case 'running':
                        return <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
                      case 'error':
                        return <XCircle className="w-3.5 h-3.5 text-red-500" />;
                      case 'skipped':
                        return <Minus className="w-3.5 h-3.5 text-slate-500" />;
                      case 'pending':
                        return <div className="w-3.5 h-3.5 rounded-full border-2 border-slate-700" />;
                      default: {
                        const _exhaustive: never = st;
                        return _exhaustive;
                      }
                    }
                  })()}
                </div>

                <div className="space-y-1">
                  <span className={`text-[11px] block ${
                    st === 'skipped' ? 'text-slate-500 line-through' : 
                    st === 'running' ? 'text-blue-100 font-medium' :
                    st === 'done' ? 'text-slate-300' :
                    'text-slate-400'
                  }`}>
                    <span className="font-mono text-slate-500 mr-2 text-[10px]">{String(i + 1).padStart(2, '0')}</span>
                    {step.description}
                  </span>
                  
                  {st === 'error' && statuses[i]?.message && (
                    <div className="text-[10px] text-red-400 font-mono mt-1 bg-red-950/30 p-2 rounded border border-red-900/30 break-words">
                      {statuses[i].message}
                      {statuses[i]?.setupUrl && (
                        <a
                          href={statuses[i].setupUrl}
                          className="block mt-1 text-amber-300 underline underline-offset-2"
                        >
                          Connect this tool
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="shrink-0 pt-0.5">
                {st === 'done' && <span className="text-[10px] text-emerald-400 font-medium">Complete</span>}
                {st === 'running' && <span className="text-[10px] text-blue-400 font-medium animate-pulse">Running</span>}
                {st === 'error' && <span className="text-[10px] text-red-400 font-medium">Failed</span>}
                {st === 'skipped' && <span className="text-[10px] text-slate-500">Skipped</span>}
                {st === 'pending' && <span className="text-[10px] text-slate-600">Pending</span>}
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
};