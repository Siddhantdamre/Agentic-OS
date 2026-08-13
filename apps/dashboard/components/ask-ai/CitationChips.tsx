'use client';

import React from 'react';
import Link from 'next/link';

const CITE_RE = /\[M-(\d+)\]/g;

export function parseMemoryCitations(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  CITE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITE_RE.exec(text || '')) !== null) {
    const id = `M-${match[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function CitationChips({ text }: { text: string }) {
  const ids = parseMemoryCitations(text);
  if (ids.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-1">
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-cream-100 text-slate-500 border border-cream-300">
          no memory
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1">
      {ids.map((id) => (
        <Link
          key={id}
          href={`/brain?q=${encodeURIComponent(id)}`}
          className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 hover:border-amber-400"
        >
          {id}
        </Link>
      ))}
    </div>
  );
}
