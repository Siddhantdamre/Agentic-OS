'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { ListChecks, Play, X, CheckSquare, Square, Zap } from 'lucide-react';

export interface PlanStep {
  id: string;
  description: string;
  tool: string;
  action: string;
  payload: Record<string, any>;
  enabled: boolean;
}

interface PlanCardProps {
  planId: string;
  summary: string;
  steps: PlanStep[];
  disabled?: boolean;
  onApprove: (planId: string) => void;
  onCancel: (planId: string) => void;
  onToggleStep: (planId: string, index: number, enabled: boolean) => void;
}

/**
 * Approvable step-by-step plan card. Fades in from 8px below; amber accent.
 */
export const PlanCard: React.FC<PlanCardProps> = ({
  planId,
  summary,
  steps,
  disabled,
  onApprove,
  onCancel,
  onToggleStep,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="mt-3 w-full bg-white border-2 border-amber-500/40 rounded-2xl p-5 space-y-4 text-xs shadow-lg"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-cream-200 pb-3">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-2xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center shrink-0">
            <ListChecks className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-serif font-bold text-heading text-sm">Execution Plan</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-800 font-bold">
                AWAITING APPROVAL
              </span>
            </div>
            <p className="text-[11px] text-slate-500">{summary || 'Multi-step autonomous workflow'}</p>
          </div>
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-2">
        {steps.map((step, idx) => {
          const StepIcon = step.tool === 'gmail' ? Zap : ListChecks;
          const toggled = !step.enabled;
          return (
            <div
              key={step.id || idx}
              className={`flex items-start space-x-3 p-3 rounded-xl border transition-all ${
                toggled
                  ? 'bg-cream-100/60 border-cream-300 opacity-60'
                  : 'bg-cream-50/80 border-amber-500/20'
              }`}
            >
              <button
                onClick={() => onToggleStep(planId, idx, !step.enabled)}
                disabled={disabled}
                className="mt-0.5 shrink-0 text-amber-600 hover:text-amber-700 transition-colors disabled:opacity-40"
                aria-label="toggle step"
              >
                {toggled ? <Square className="w-4 h-4" /> : <CheckSquare className="w-4 h-4" />}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <span className="font-mono text-[10px] text-amber-700 bg-amber-500/10 rounded px-1.5 py-0.5">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <StepIcon className="w-3.5 h-3.5 text-amber-600" />
                  <p className={`font-semibold text-heading ${toggled ? 'line-through' : ''}`}>
                    {step.description}
                  </p>
                </div>
                <p className="text-[10px] font-mono text-slate-500 mt-0.5 truncate">
                  <span className="text-amber-700">{step.tool}</span>
                  <span className="text-slate-400"> → </span>
                  {step.action}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex items-center space-x-3 pt-1">
        <button
          onClick={() => onApprove(planId)}
          disabled={disabled}
          className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-heading font-bold text-xs rounded-xl flex items-center justify-center space-x-2 shadow-sm transition-all disabled:opacity-40"
        >
          <Play className="w-3.5 h-3.5" />
          <span>Approve &amp; Run</span>
        </button>
        <button
          onClick={() => onCancel(planId)}
          disabled={disabled}
          className="py-2.5 px-4 bg-cream-200 hover:bg-cream-300 text-slate-600 font-semibold text-xs rounded-xl transition-all disabled:opacity-40"
        >
          <X className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
          Cancel
        </button>
      </div>
    </motion.div>
  );
};