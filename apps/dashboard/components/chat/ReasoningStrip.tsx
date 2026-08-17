'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BrainCircuit, ChevronDown } from 'lucide-react';

interface ReasoningStripProps {
  text: string;
  durationMs?: number | null;
  autoCollapse?: boolean;
}

export const ReasoningStrip: React.FC<ReasoningStripProps> = ({ text, durationMs }) => {
  const [open, setOpen] = useState(false);

  const formattedDuration = durationMs
    ? durationMs >= 1000
      ? `${(durationMs / 1000).toFixed(1)}s`
      : `${durationMs}ms`
    : '1.2s';

  return (
    <div className="mt-4 mb-2 w-full font-sans">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center space-x-2 px-1 py-1 text-[11px] text-slate-500 hover:text-slate-800 transition-colors focus:outline-none group"
      >
        <BrainCircuit className="w-3.5 h-3.5" />
        <span className="font-medium">Synthesized in {formattedDuration}</span>
        <ChevronDown
          className={`w-3 h-3 transition-transform duration-200 opacity-50 group-hover:opacity-100 ${open ? 'rotate-180' : ''}`}
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
            <div className="mt-2 pl-4 ml-2 border-l-2 border-slate-200 py-1 text-[11px] text-slate-600 font-mono leading-relaxed max-w-2xl">
              {text || 'Analyzing business context, verifying connector states, and mapping sequential execution plan...'}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};