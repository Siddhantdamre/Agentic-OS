'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ListChecks, ArrowRight, X, CheckSquare, Square, Plus, Edit3, CircleDashed } from 'lucide-react';
import type { PlanStep } from '@darex/shared-types';

export type { PlanStep };

interface PlanCardProps {
  planId: string;
  summary: string;
  steps: PlanStep[];
  disabled?: boolean;
  onApprove: (planId: string) => void;
  onCancel: (planId: string) => void;
  onToggleStep: (planId: string, index: number, enabled: boolean) => void;
  onAddInstruction?: (planId: string, instruction: string) => void;
}

export const PlanCard: React.FC<PlanCardProps> = ({
  planId,
  summary,
  steps,
  disabled,
  onApprove,
  onCancel,
  onToggleStep,
  onAddInstruction,
}) => {
  const [extraInstruction, setExtraInstruction] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  const handleAddInstructionSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!extraInstruction.trim()) return;
    onAddInstruction?.(planId, extraInstruction.trim());
    setExtraInstruction('');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mt-4 w-full bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden font-sans"
    >
      {/* Header */}
      <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-start space-x-3">
          <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
            <ListChecks className="w-4 h-4 text-slate-700" />
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 text-sm">Execution Plan</h3>
            {summary && <p className="text-xs text-slate-500 mt-1 max-w-lg leading-relaxed">{summary}</p>}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsEditing((v) => !v)}
          disabled={disabled}
          className="px-2.5 py-1.5 bg-white hover:bg-slate-50 text-slate-600 font-medium text-xs rounded-lg border border-slate-200 flex items-center space-x-1.5 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-100 disabled:opacity-50"
        >
          <Edit3 className="w-3.5 h-3.5" />
          <span>{isEditing ? 'Done' : 'Edit'}</span>
        </button>
      </div>

      {/* Ordered Steps List */}
      <div className="p-2 space-y-1 bg-white">
        {steps.map((step, idx) => {
          const isSkipped = !step.enabled;
          const toolTag = step.tool.includes('.') ? step.tool : `mcp.${step.tool}.${step.action}`;

          return (
            <div
              key={step.id || idx}
              className={`flex items-start space-x-3 p-3 rounded-xl transition-all ${
                isSkipped
                  ? 'opacity-60 bg-slate-50'
                  : 'bg-white hover:bg-slate-50'
              }`}
            >
              <button
                type="button"
                onClick={() => onToggleStep(planId, idx, !step.enabled)}
                disabled={disabled}
                className={`mt-0.5 shrink-0 transition-colors focus:outline-none disabled:cursor-not-allowed ${
                  isSkipped ? 'text-slate-400' : 'text-blue-600 hover:text-blue-700'
                }`}
                aria-label="toggle step"
              >
                {isSkipped ? (
                  <Square className="w-4 h-4" />
                ) : (
                  <CheckSquare className="w-4 h-4 fill-blue-50 text-blue-600" />
                )}
              </button>

              <div className="flex-1 min-w-0 pt-0.5">
                <div className="flex items-start">
                  <span className={`font-mono text-[10px] font-medium mr-2 mt-0.5 ${isSkipped ? 'text-slate-400' : 'text-slate-500'}`}>
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <p className={`text-xs ${isSkipped ? 'line-through text-slate-500' : 'font-medium text-slate-900'}`}>
                    {step.description}
                  </p>
                </div>
                <div className="flex items-center space-x-2 mt-2">
                  <span className="inline-flex text-[9px] font-mono font-medium text-slate-500 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                    {toolTag}
                  </span>
                  {isSkipped && <span className="text-[10px] text-slate-400 italic">Skipped</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Secondary Inline Input for "+ Add instruction..." */}
      <div className="px-4 pb-4 bg-white">
        <form onSubmit={handleAddInstructionSubmit} className="relative group">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Plus className="w-4 h-4 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
          </div>
          <input
            type="text"
            value={extraInstruction}
            onChange={(e) => setExtraInstruction(e.target.value)}
            placeholder="Add an instruction to this plan..."
            disabled={disabled}
            className="w-full pl-9 pr-16 py-2.5 bg-slate-50 hover:bg-slate-100 focus:bg-white border border-slate-200 focus:border-blue-300 focus:ring-2 focus:ring-blue-100 rounded-xl text-xs text-slate-900 placeholder-slate-500 outline-none transition-all disabled:opacity-50"
          />
          {extraInstruction.trim() && (
            <button
              type="submit"
              disabled={disabled}
              className="absolute inset-y-1.5 right-1.5 px-3 bg-blue-600 hover:bg-blue-700 text-white font-medium text-[10px] rounded-lg transition-colors focus:outline-none"
            >
              Add
            </button>
          )}
        </form>
      </div>

      {/* Footer Controls */}
      <div className="flex items-center space-x-3 p-5 border-t border-slate-100 bg-slate-50/50">
        <button
          type="button"
          onClick={() => onApprove(planId)}
          disabled={disabled}
          className="flex-1 py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs rounded-xl flex items-center justify-center space-x-2 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-slate-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span>Approve & Execute</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        
        <button
          type="button"
          onClick={() => onCancel(planId)}
          disabled={disabled}
          className="py-2.5 px-5 bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 font-medium text-xs rounded-xl transition-all focus:outline-none focus:ring-2 focus:ring-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>
    </motion.div>
  );
};