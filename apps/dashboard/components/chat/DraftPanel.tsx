'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, RefreshCw, CheckCircle2, CornerDownLeft, RotateCcw, Check } from 'lucide-react';

export interface DraftState {
  content: string;
  version: number;
  accepted?: boolean;
}

interface DraftPanelProps {
  draft: DraftState;
  planId: string;
  editable?: boolean;
  onRevised?: (draft: DraftState) => void;
  onAccept?: () => void;
}

/**
 * Claude-style Draft Panel:
 * ┌─────────────────────────────────────────┐
 * │ Draft                      [Regenerate] │
 * ├─────────────────────────────────────────┤
 * │  (full draft content, scrollable,       │
 * │   document-style — not chat-bubble)     │
 * ├─────────────────────────────────────────┤
 * │ Leave feedback...                    ↵  │  ← inline comment input
 * ├─────────────────────────────────────────┤
 * │      [Request changes]    [Accept] ✓    │
 * └─────────────────────────────────────────┘
 */
export const DraftPanel: React.FC<DraftPanelProps> = ({ draft, planId, editable = true, onRevised, onAccept }) => {
  const [feedback, setFeedback] = useState('');
  const [revising, setRevising] = useState(false);
  const [accepted, setAccepted] = useState(Boolean(draft.accepted));
  const [error, setError] = useState<string | null>(null);

  const handleRevise = async () => {
    if (!feedback.trim() || revising) return;
    setRevising(true);
    setError(null);
    try {
      const res = await fetch('/api/ask-ai/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, feedback: feedback.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setFeedback('');
        onRevised?.(data.draft);
      } else {
        setError(data.error || 'Revision request failed');
      }
    } catch (err: any) {
      setError(err?.message || 'Revision request failed');
    } finally {
      setRevising(false);
    }
  };

  const handleRegenerate = async () => {
    if (revising) return;
    setRevising(true);
    setError(null);
    try {
      const res = await fetch('/api/ask-ai/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, feedback: 'Please regenerate the full draft with fresh improvements.' }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onRevised?.(data.draft);
      } else {
        setError(data.error || 'Regenerate failed');
      }
    } catch (err: any) {
      setError(err?.message || 'Regenerate failed');
    } finally {
      setRevising(false);
    }
  };

  const handleAccept = () => {
    setAccepted(true);
    onRevised?.({ ...draft, accepted: true });
    onAccept?.();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mt-3 w-full bg-white border-2 border-amber-500/40 rounded-2xl p-5 space-y-4 text-xs shadow-lg"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-cream-300 pb-3">
        <div className="flex items-center space-x-2">
          <div className="w-7 h-7 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
            <FileText className="w-4 h-4 text-amber-600" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="font-serif font-bold text-heading text-sm">Draft</h3>
              <span className="font-mono text-[10px] text-amber-800 bg-amber-500/15 rounded-full px-2 py-0.5 font-bold">
                v{draft.version}
              </span>
              {accepted && (
                <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 flex items-center space-x-1">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>Accepted</span>
                </span>
              )}
            </div>
          </div>
        </div>

        {!accepted && (
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={revising}
            className="px-2.5 py-1 bg-cream-100 hover:bg-cream-200 text-slate-700 font-semibold text-[11px] rounded-lg border border-cream-300 flex items-center space-x-1.5 transition-all disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 text-amber-600 ${revising ? 'animate-spin' : ''}`} />
            <span>Regenerate</span>
          </button>
        )}
      </div>

      {/* Full Document Style Scrollable Box */}
      <div className="relative rounded-xl border border-cream-300 bg-cream-50/60 p-4 max-h-[300px] overflow-y-auto font-sans leading-relaxed text-slate-800 text-xs shadow-inner">
        {editable && !accepted ? (
          <textarea
            value={draft.content}
            onChange={(e) => onRevised?.({ ...draft, content: e.target.value })}
            className="w-full min-h-[160px] bg-transparent border-none text-slate-800 font-sans text-xs leading-relaxed focus:outline-none resize-y"
          />
        ) : (
          <div className="whitespace-pre-wrap font-sans text-slate-800">{draft.content}</div>
        )}
      </div>

      {/* Leave Feedback Inline Input */}
      {!accepted && (
        <div className="space-y-2">
          <div className="relative flex items-center">
            <input
              type="text"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRevise()}
              placeholder="Leave feedback... (press Enter to request changes)"
              disabled={revising}
              className="w-full pl-3 pr-9 py-2.5 bg-white border border-cream-300 focus:border-amber-500 rounded-xl text-[11px] text-heading placeholder-slate-400 focus:outline-none transition-all disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleRevise}
              disabled={!feedback.trim() || revising}
              className="absolute right-2 p-1 text-amber-600 hover:text-amber-700 disabled:opacity-30 transition-colors"
              title="Submit feedback"
            >
              {revising ? <RotateCcw className="w-3.5 h-3.5 animate-spin" /> : <CornerDownLeft className="w-3.5 h-3.5" />}
            </button>
          </div>

          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-[10px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          {/* Action Buttons: Request changes / Accept */}
          <div className="flex items-center space-x-3 pt-2 border-t border-cream-200">
            <button
              type="button"
              onClick={handleRevise}
              disabled={!feedback.trim() || revising}
              className="flex-1 py-2.5 px-4 bg-cream-200 hover:bg-cream-300 text-slate-700 font-semibold text-xs rounded-xl flex items-center justify-center space-x-1.5 transition-all disabled:opacity-40"
            >
              <RotateCcw className={`w-3.5 h-3.5 ${revising ? 'animate-spin' : ''}`} />
              <span>Request changes</span>
            </button>

            <button
              type="button"
              onClick={handleAccept}
              disabled={revising}
              className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-heading font-bold text-xs rounded-xl flex items-center justify-center space-x-1.5 shadow-sm transition-all disabled:opacity-40"
            >
              <span>Accept</span>
              <Check className="w-4 h-4 font-bold" />
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
};