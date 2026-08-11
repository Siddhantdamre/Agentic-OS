'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, Send, RotateCcw, CheckCircle2 } from 'lucide-react';

export interface DraftState {
  content: string;
  version: number;
}

interface DraftPanelProps {
  draft: DraftState;
  planId: string;
  editable?: boolean;
  onRevised?: (draft: DraftState) => void;
}

/**
 * Draft-for-review panel. Editable textarea + feedback loop that calls the
 * /api/ask-ai/revise backend and swaps in the improved draft (v+1).
 */
export const DraftPanel: React.FC<DraftPanelProps> = ({ draft, planId, editable, onRevised }) => {
  const [feedback, setFeedback] = useState('');
  const [revisions, setRevisions] = useState<number>(0);
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRevise = async () => {
    if (!feedback.trim() || revising) return;
    setRevising(true);
    setError(null);
    try {
      const res = await fetch('/api/ask-ai/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, feedback }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setRevisions((r) => r + 1);
        setFeedback('');
        onRevised?.(data.draft);
      } else {
        setError(data.error || 'Revision failed');
      }
    } catch (err: any) {
      setError(err?.message || 'Revision failed');
    } finally {
      setRevising(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="mt-3 w-full bg-white border border-amber-500/40 rounded-2xl p-5 space-y-3 text-xs shadow-lg"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center space-x-2 font-bold text-heading">
          <FileText className="w-4 h-4 text-amber-600" />
          <span>Draft for Review</span>
          <span className="font-mono text-[10px] text-amber-700 bg-amber-500/10 rounded-full px-2 py-0.5">
            v{draft.version}
          </span>
        </span>
        {revisions > 0 && (
          <span className="text-[10px] text-emerald-600 font-semibold flex items-center space-x-1">
            <CheckCircle2 className="w-3 h-3" />
            <span>{revisions} revision{revisions > 1 ? 's' : ''}</span>
          </span>
        )}
      </div>

      <textarea
        value={draft.content}
        readOnly={!editable}
        onChange={(e) => onRevised?.({ ...draft, content: e.target.value })}
        className="w-full min-h-[120px] p-3 bg-cream-50 border border-cream-300 rounded-xl text-[11px] text-slate-700 leading-relaxed resize-y focus:outline-none focus:border-amber-500"
        placeholder="Draft appears here…"
      />

      {editable && (
        <>
          <div className="flex items-end space-x-2">
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Feedback: make it more formal, shorten it, mention pricing, add next steps…"
              className="flex-1 p-2.5 bg-white border border-cream-300 rounded-xl text-[11px] text-heading resize-none h-[52px] focus:outline-none focus:border-amber-500"
            />
            <button
              onClick={handleRevise}
              disabled={!feedback.trim() || revising}
              className="px-4 h-[52px] bg-amber-500 hover:bg-amber-600 text-heading font-bold text-[11px] rounded-xl flex items-center space-x-1.5 transition-all disabled:opacity-40"
            >
              {revising ? <RotateCcw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span>{revising ? 'Revising…' : 'Revise'}</span>
            </button>
          </div>

          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-[11px] text-red-600 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>
        </>
      )}
    </motion.div>
  );
};