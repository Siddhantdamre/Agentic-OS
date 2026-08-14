'use client';

import React, { useState } from 'react';
import { Copy, Check, Sparkles, AlertCircle, ArrowRight, Code2 } from 'lucide-react';

interface FormattedMarkdownResponseProps {
  content: string;
}

export const FormattedMarkdownResponse: React.FC<FormattedMarkdownResponseProps> = ({ content }) => {
  const [copiedBlockIndex, setCopiedBlockIndex] = useState<number | null>(null);

  if (!content) {
    return <div className="text-xs text-slate-500">No content</div>;
  }

  const handleCopyCode = (codeText: string, index: number) => {
    navigator.clipboard.writeText(codeText);
    setCopiedBlockIndex(index);
    setTimeout(() => setCopiedBlockIndex(null), 2000);
  };

  // Split content by code blocks first
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-3.5 text-xs text-slate-800 leading-relaxed font-sans">
      {parts.map((part, index) => {
        // Render Code Block
        if (part.startsWith('```') && part.endsWith('```')) {
          const match = part.match(/^```(\w+)?\n([\s\S]*?)```$/);
          const lang = match ? match[1] || 'code' : 'code';
          const codeText = match ? match[2].trim() : part.slice(3, -3).trim();

          return (
            <div key={index} className="my-3 rounded-2xl overflow-hidden border border-slate-800 bg-slate-900 shadow-md">
              <div className="flex items-center justify-between px-4 py-2 bg-slate-950/80 border-b border-slate-800 text-[11px] text-slate-400 font-mono">
                <div className="flex items-center space-x-2">
                  <Code2 className="w-3.5 h-3.5 text-amber-500" />
                  <span className="uppercase font-bold tracking-wider">{lang}</span>
                </div>

                <button
                  onClick={() => handleCopyCode(codeText, index)}
                  className="flex items-center space-x-1 hover:text-amber-400 transition-colors text-[10px] font-sans px-2 py-0.5 rounded-lg bg-slate-800"
                >
                  {copiedBlockIndex === index ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400 font-semibold">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 text-slate-400" />
                      <span>Copy Code</span>
                    </>
                  )}
                </button>
              </div>

              <pre className="p-4 overflow-x-auto text-[11px] text-emerald-300 font-mono leading-normal bg-slate-900/90">
                <code>{codeText}</code>
              </pre>
            </div>
          );
        }

        // Render Regular Markdown Text
        const lines = part.split('\n');
        return (
          <div key={index} className="space-y-2">
            {lines.map((line, lineIdx) => {
              const trimmed = line.trim();
              if (!trimmed) return null;

              // Headers: ### Header Name
              if (trimmed.startsWith('### ')) {
                return (
                  <h3 key={lineIdx} className="text-sm font-serif font-bold text-heading pt-2 pb-1 border-b border-cream-200 flex items-center space-x-2">
                    <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
                    <span>{trimmed.slice(4)}</span>
                  </h3>
                );
              }

              if (trimmed.startsWith('## ')) {
                return (
                  <h2 key={lineIdx} className="text-base font-serif font-bold text-heading pt-3 pb-1 border-b border-cream-300">
                    {trimmed.slice(3)}
                  </h2>
                );
              }

              if (trimmed.startsWith('# ')) {
                return (
                  <h1 key={lineIdx} className="text-lg font-serif font-bold text-heading pt-3 pb-1 border-b border-amber-500/30">
                    {trimmed.slice(2)}
                  </h1>
                );
              }

              // Bullet points: * item or - item
              if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
                const bulletText = trimmed.slice(2);
                return (
                  <div key={lineIdx} className="flex items-start space-x-2 pl-1 py-0.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-1.5 shrink-0" />
                    <div className="flex-1">
                      {parseFormattedText(bulletText)}
                    </div>
                  </div>
                );
              }

              // Numbered list: 1. item, 2. item
              const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
              if (numMatch) {
                return (
                  <div key={lineIdx} className="flex items-start space-x-2.5 pl-1 py-0.5">
                    <span className="w-4 h-4 rounded-full bg-amber-500/20 text-amber-700 font-bold text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                      {numMatch[1]}
                    </span>
                    <div className="flex-1">
                      {parseFormattedText(numMatch[2])}
                    </div>
                  </div>
                );
              }

              // Callout / Recommendation box
              if (trimmed.startsWith('> ') || trimmed.toLowerCase().includes('recommendation:') || trimmed.toLowerCase().includes('action:')) {
                return (
                  <div key={lineIdx} className="my-2 p-3.5 bg-amber-500/10 border-l-4 border-amber-500 rounded-r-2xl text-slate-800 text-[11px] font-medium flex items-start space-x-2.5">
                    <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div className="flex-1">
                      {parseFormattedText(trimmed.replace(/^>\s*/, ''))}
                    </div>
                  </div>
                );
              }

              // Normal paragraph
              return (
                <p key={lineIdx} className="leading-relaxed text-slate-700 font-sans">
                  {parseFormattedText(trimmed)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

/**
 * Helper to parse **bold** and `code` inline formatting inside strings
 */
function parseFormattedText(text: string) {
  // Regex to match **bold** or `inline code`
  const tokens = text.split(/(\*\*[\s\S]*?\*\*|`[^`]+`)/g);

  return tokens.map((token, i) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      return (
        <strong key={i} className="font-bold text-heading">
          {token.slice(2, -2)}
        </strong>
      );
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code key={i} className="px-1.5 py-0.5 mx-0.5 rounded-md bg-cream-200 text-amber-700 font-mono text-[11px] font-semibold border border-cream-300">
          {token.slice(1, -1)}
        </code>
      );
    }
    return token;
  });
}
