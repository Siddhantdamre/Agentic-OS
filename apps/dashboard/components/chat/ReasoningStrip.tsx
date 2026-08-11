'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Brain, ChevronDown, Sparkles } from 'lucide-react';

interface ReasoningStripProps {
  text: string;
  durationMs?: number | null;
}

/**
 * Collapsible "reasoning" strip shown above a plan card. Expands with a quick
 * easeOut animation into muted italic text. Amber pulse dot while thinking.
 */
export const ReasoningStrip: React.FC<ReasoningStripProps> = ({ text, durationMs }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 w-full">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2 bg-amber-500/10 border border-amber-500/25 rounded-2xl text-[11px] text-amber-900 transition-colors hover:bg-amber-500/15"
      >
        <span className="flex items-center space-x-2">
          <span className="relative flex w-2 h-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-600" />
          </span>
          <Brain className="w-3.5 h-3.5 text-amber-600" />
          <span className="font-bold">AI Reasoning</span>
          {durationMs ? (
            <span className="font-mono text-[10px] text-amber-700/70">{durationMs}ms</span>
          ) : null}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-amber-700 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
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
            <div className="mt-1.5 px-4 py-3 bg-cream-50 border border-cream-300 rounded-2xl text-[11px] italic text-slate-600 leading-relaxed">
              <Sparkles className="w-3 h-3 text-amber-500 inline-block mr-1.5 -mt-0.5" />
              {text}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};