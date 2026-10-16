'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BrainCircuit, ChevronDown } from 'lucide-react';

export interface ReasoningStripProps {
  text: string;
  durationMs?: number | null;
  autoCollapse?: boolean;
  isStreaming?: boolean;
  active?: boolean;
}

export const ReasoningStrip: React.FC<ReasoningStripProps> = ({
  text,
  durationMs,
  autoCollapse,
  isStreaming,
  active,
}) => {
  const [open, setOpen] = useState(false);

  const isThinking = Boolean(isStreaming || active);

  const formattedDuration =
    typeof durationMs === 'number' && durationMs > 0
      ? durationMs >= 1000
        ? `${(durationMs / 1000).toFixed(1)}s`
        : `${durationMs}ms`
      : null;

  const headerLabel = isThinking
    ? 'Thinking...'
    : formattedDuration
    ? `Synthesized in ${formattedDuration}`
    : 'Synthesis';

  return (
    <div className="relative mt-3 mb-2 w-full rounded-xl border border-cream-200/80 bg-cream-50/80 overflow-hidden font-sans transition-all shadow-xs">
      {isThinking && (
        <div className="h-0.5 w-full thinking-shimmer" />
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3.5 py-2 text-[11px] text-slate-600 hover:text-slate-900 transition-colors focus:outline-none group select-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <BrainCircuit className="w-3.5 h-3.5 text-amber-700 shrink-0" />
          <span className="font-semibold text-slate-700 truncate">
            {headerLabel}
          </span>
          {isThinking && (
            <span className="flex h-1.5 w-1.5 relative shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 group-hover:text-slate-600 shrink-0 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 pt-0.5">
              <div className="pl-3 border-l-2 border-amber-400/40 py-1 text-[11px] text-slate-600 font-mono leading-relaxed max-w-3xl whitespace-pre-wrap break-words">
                {text || 'Analyzing business context, verifying connector states, and mapping sequential execution plan...'}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};