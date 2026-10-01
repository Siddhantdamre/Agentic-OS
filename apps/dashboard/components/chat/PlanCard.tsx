'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ListChecks, ArrowRight, CheckSquare, Square, Plus, Edit3 } from 'lucide-react';
import type { PlanStep } from '@darex/shared-types';

export type { PlanStep };

interface PlanCardProps {
  planId: string;
  summary: string;
  steps: PlanStep[];
  disabled?: boolean;
  status?: string;
  onApprove: (planId: string) => void;
  onCancel: (planId: string) => void;
  onToggleStep: (planId: string, index: number, enabled: boolean) => void;
  onAddInstruction?: (planId: string, instruction: string) => void;
  onUpdateStepPayload?: (planId: string, index: number, payload: Record<string, unknown>) => void;
}

export const PlanCard: React.FC<PlanCardProps> = ({
  planId,
  summary,
  steps,
  disabled,
  status,
  onApprove,
  onCancel,
  onToggleStep,
  onAddInstruction,
  onUpdateStepPayload,
}) => {
  const [extraInstruction, setExtraInstruction] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editingPayloadIndex, setEditingPayloadIndex] = useState<number | null>(null);
  const [payloadDraft, setPayloadDraft] = useState('');
  const [payloadError, setPayloadError] = useState<string | null>(null);

  const handleAddInstructionSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!extraInstruction.trim()) return;
    onAddInstruction?.(planId, extraInstruction.trim());
    setExtraInstruction('');
  };

  const startPayloadEdit = (idx: number, step: PlanStep) => {
    setEditingPayloadIndex(idx);
    setPayloadDraft(JSON.stringify(step.payload || {}, null, 2));
    setPayloadError(null);
  };

  const savePayloadEdit = () => {
    if (editingPayloadIndex == null) return;
    try {
      const parsed = JSON.parse(payloadDraft) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setPayloadError('Payload must be a JSON object');
        return;
      }
      onUpdateStepPayload?.(planId, editingPayloadIndex, parsed as Record<string, unknown>);
      setEditingPayloadIndex(null);
      setPayloadError(null);
    } catch {
      setPayloadError('Invalid JSON');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mt-4 w-full bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden font-sans"
    >
      <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-start space-x-3">
          <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
            <ListChecks className="w-4 h-4 text-slate-700" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="font-semibold text-slate-900 text-sm">Execution Plan</h3>
              {status && (
                <span
                  className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                    status === 'approved'
                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                      : status === 'completed'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : status === 'pending'
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-slate-50 text-slate-700 border-slate-200'
                  }`}
                  data-testid="plan-status-badge"
                >
                  {status === 'pending' ? 'Pending Approval' : status.replace(/_/g, ' ')}
                </span>
              )}
            </div>
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

      <div className="p-2 space-y-1 bg-white">
        {steps.map((step, idx) => {
          const isSkipped = !step.enabled;
          const toolTag = step.tool.includes('.') ? step.tool : `mcp.${step.tool}.${step.action}`;

          return (
            <div
              key={step.id || idx}
              className={`flex items-start space-x-3 p-3 rounded-xl transition-all ${
                isSkipped ? 'opacity-60 bg-slate-50' : 'bg-white hover:bg-slate-50'
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
                  <CheckSquare className="w-4 h-4 fill-amber-500/20 text-amber-600" />
                )}
              </button>

              <div className="flex-1 min-w-0 pt-0.5 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start min-w-0">
                    <span
                      className={`font-mono text-[10px] font-medium mr-2 mt-0.5 ${
                        isSkipped ? 'text-slate-400' : 'text-slate-500'
                      }`}
                    >
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <p
                      className={`text-xs ${
                        isSkipped ? 'line-through text-slate-500' : 'font-medium text-slate-900'
                      }`}
                    >
                      {step.description}
                    </p>
                  </div>
                  {isEditing && onUpdateStepPayload && !disabled ? (
                    <button
                      type="button"
                      onClick={() => startPayloadEdit(idx, step)}
                      className="shrink-0 text-[10px] font-semibold text-amber-700 hover:text-amber-800"
                    >
                      Edit params
                    </button>
                  ) : null}
                </div>
                <div className="flex items-center space-x-2">
                  <span className="inline-flex text-[9px] font-mono font-medium text-slate-500 bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                    {toolTag}
                  </span>
                  {isSkipped && <span className="text-[10px] text-slate-400 italic">Skipped</span>}
                </div>

                {editingPayloadIndex === idx ? (
                  <div className="space-y-2">
                    <textarea
                      value={payloadDraft}
                      onChange={(e) => setPayloadDraft(e.target.value)}
                      rows={5}
                      className="w-full p-2 font-mono text-[11px] bg-slate-50 border border-slate-200 rounded-lg text-slate-800"
                    />
                    {payloadError ? <p className="text-[10px] text-rose-600">{payloadError}</p> : null}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingPayloadIndex(null);
                          setPayloadError(null);
                        }}
                        className="px-2 py-1 text-[11px] text-slate-500"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={savePayloadEdit}
                        className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 text-white"
                      >
                        Save params
                      </button>
                    </div>
                  </div>
                ) : step.payload && Object.keys(step.payload).length > 0 ? (
                  <pre className="text-[10px] font-mono text-slate-500 bg-slate-50 border border-slate-100 rounded-lg p-2 overflow-x-auto max-h-24">
                    {JSON.stringify(step.payload, null, 2)}
                  </pre>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-4 pb-4 bg-white">
        <form onSubmit={handleAddInstructionSubmit} className="relative group">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Plus className="w-4 h-4 text-slate-400 group-focus-within:text-amber-500 transition-colors" />
          </div>
          <input
            type="text"
            value={extraInstruction}
            onChange={(e) => setExtraInstruction(e.target.value)}
            placeholder="Add an instruction to this plan..."
            disabled={disabled}
            className="w-full pl-9 pr-16 py-2.5 bg-slate-50 hover:bg-slate-100 focus:bg-white border border-slate-200 focus:border-amber-400 focus:ring-2 focus:ring-amber-200/50 rounded-xl text-xs text-slate-900 placeholder-slate-500 outline-none transition-all disabled:opacity-50"
          />
          {extraInstruction.trim() && (
            <button
              type="submit"
              disabled={disabled}
              className="absolute inset-y-1.5 right-1.5 px-3 bg-amber-500 hover:bg-amber-600 text-heading font-bold text-[10px] rounded-lg transition-colors focus:outline-none"
            >
              Add
            </button>
          )}
        </form>
      </div>

      <div className="flex items-center space-x-3 p-5 border-t border-slate-100 bg-slate-50/50">
        <button
          type="button"
          onClick={() => onApprove(planId)}
          disabled={disabled || status === 'approved'}
          className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-heading font-bold text-xs rounded-xl flex items-center justify-center space-x-2 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-amber-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
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
