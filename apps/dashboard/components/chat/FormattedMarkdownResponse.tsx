'use client';

import React, { useState } from 'react';
import dynamic from 'next/dynamic';
import { ConnectorSignInControl } from '@/components/chat/ConnectorSignInLink';
import { providerIdFromConnectHref } from '@/lib/integrations-catalog';
import {
  Copy,
  Check,
  Sparkles,
  AlertCircle,
  ArrowRight,
  Code2,
  ExternalLink,
  Presentation,
  FileText,
  Table,
  Globe,
  ArrowUpRight,
} from 'lucide-react';

const OpenUiFenceBlock = dynamic(
  () => import('./OpenUiFenceBlock').then((m) => m.OpenUiFenceBlock),
  {
    ssr: false,
    loading: () => (
      <div className="my-2 rounded-xl border border-cream-200 bg-cream-50 p-3 text-xs text-slate-500 font-mono animate-pulse">
        Loading interactive widget...
      </div>
    ),
  }
);

interface FormattedMarkdownResponseProps {
  content: string;
  isStreaming?: boolean;
  darkTheme?: boolean;
}

export const FormattedMarkdownResponse: React.FC<FormattedMarkdownResponseProps> = ({
  content,
  isStreaming = false,
  darkTheme = false,
}) => {
  const [copiedBlockIndex, setCopiedBlockIndex] = useState<number | null>(null);

  if (!content) {
    return <div className="text-xs text-slate-500">No content</div>;
  }

  const handleCopyCode = (codeText: string, index: number) => {
    navigator.clipboard.writeText(codeText);
    setCopiedBlockIndex(index);
    setTimeout(() => setCopiedBlockIndex(null), 2000);
  };

  // If streaming and an open code block exists, temporarily close it so OpenUI can parse and render live
  let parsedContent = content;
  const backtickCount = (content.match(/```/g) || []).length;
  if (isStreaming && backtickCount % 2 !== 0) {
    parsedContent = content + '\n```';
  }

  // Split content by code blocks first
  const parts = parsedContent.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-3.5 text-[13px] sm:text-sm text-slate-800 leading-relaxed font-sans">
      {parts.map((part, index) => {
        // Render Code Block
        if (part.startsWith('```') && part.endsWith('```')) {
          const match = part.match(/^```(\w+)?\n([\s\S]*?)```$/);
          const lang = match ? match[1] || 'code' : 'code';
          const codeText = match ? match[2].trim() : part.slice(3, -3).trim();

          if (lang.toLowerCase() === 'openui') {
            return (
              <OpenUiFenceBlock
                key={index}
                content={codeText}
                isStreaming={isStreaming}
                darkTheme={darkTheme}
              />
            );
          }

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

              <pre className="p-4 overflow-x-auto text-[11px] sm:text-xs text-emerald-300 font-mono leading-normal bg-slate-900/90 max-h-80">
                <code>{codeText}</code>
              </pre>
            </div>
          );
        }

        // Render Regular Markdown Text (including tables, headers, lists, callouts)
        const lines = part.split('\n');
        return (
          <div key={index} className="space-y-2">
            {renderMarkdownLines(lines)}
          </div>
        );
      })}
      {isStreaming ? (
        <span
          aria-hidden
          className="inline-block w-1.5 h-4 align-[-2px] ml-0.5 rounded-sm bg-amber-500 animate-pulse"
        />
      ) : null}
    </div>
  );
};

/**
 * Render structured markdown lines, grouping consecutive table lines into styled tables.
 */
function renderMarkdownLines(lines: string[]) {
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // Detect markdown table block: starts and ends with '|'
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const tableLines: string[] = [];
      const startIdx = i;
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const headerCells = tableLines[0]
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());

        let bodyStartIndex = 1;
        // Check if row 1 is a delimiter row (|---|---|)
        if (tableLines.length > 1 && /^\|(\s*:?-+:?\s*\|)+$/.test(tableLines[1])) {
          bodyStartIndex = 2;
        }

        const bodyRows = tableLines.slice(bodyStartIndex).map((r) =>
          r
            .split('|')
            .slice(1, -1)
            .map((c) => c.trim())
        );

        elements.push(
          <div key={`table-${startIdx}`} className="my-3 w-full overflow-x-auto rounded-xl border border-cream-300 shadow-sm bg-white">
            <table className="w-full text-left text-xs text-slate-800 divide-y divide-cream-200">
              <thead className="bg-cream-100/90 font-serif font-bold text-heading">
                <tr>
                  {headerCells.map((h, hIdx) => (
                    <th key={hIdx} className="px-3.5 py-2.5 font-semibold">
                      {parseFormattedText(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-100">
                {bodyRows.map((row, rIdx) => (
                  <tr key={rIdx} className={rIdx % 2 === 0 ? 'bg-white' : 'bg-cream-50/40'}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-3.5 py-2 text-slate-700 font-sans">
                        {parseFormattedText(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }
    }

    // Headers: ### Header Name
    if (trimmed.startsWith('### ')) {
      elements.push(
        <h3 key={i} className="text-sm font-serif font-bold text-heading pt-2 pb-1 border-b border-cream-200 flex items-center space-x-2">
          <Sparkles className="w-4 h-4 text-amber-500 shrink-0" />
          <span>{trimmed.slice(4)}</span>
        </h3>
      );
      i++;
      continue;
    }

    if (trimmed.startsWith('## ')) {
      elements.push(
        <h2 key={i} className="text-base font-serif font-bold text-heading pt-3 pb-1 border-b border-cream-300">
          {trimmed.slice(3)}
        </h2>
      );
      i++;
      continue;
    }

    if (trimmed.startsWith('# ')) {
      elements.push(
        <h1 key={i} className="text-lg font-serif font-bold text-heading pt-3 pb-1 border-b border-amber-500/30">
          {trimmed.slice(2)}
        </h1>
      );
      i++;
      continue;
    }

    // Bullet points: * item or - item
    if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
      const bulletText = trimmed.slice(2);
      elements.push(
        <div key={i} className="flex items-start space-x-2 pl-1 py-0.5">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-2 shrink-0" />
          <div className="flex-1">
            {parseFormattedText(bulletText)}
          </div>
        </div>
      );
      i++;
      continue;
    }

    // Numbered list: 1. item, 2. item
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      elements.push(
        <div key={i} className="flex items-start space-x-2.5 pl-1 py-0.5">
          <span className="w-4 h-4 rounded-full bg-amber-500/20 text-amber-800 font-bold text-[10px] flex items-center justify-center shrink-0 mt-0.5">
            {numMatch[1]}
          </span>
          <div className="flex-1">
            {parseFormattedText(numMatch[2])}
          </div>
        </div>
      );
      i++;
      continue;
    }

    // Callout / Recommendation box
    if (trimmed.startsWith('> ') || trimmed.toLowerCase().includes('recommendation:') || trimmed.toLowerCase().includes('action:')) {
      elements.push(
        <div key={i} className="my-2 p-3.5 bg-amber-500/10 border-l-4 border-amber-500 rounded-r-2xl text-slate-800 text-xs font-medium flex items-start space-x-2.5">
          <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1">
            {parseFormattedText(trimmed.replace(/^>\s*/, ''))}
          </div>
        </div>
      );
      i++;
      continue;
    }

    // Check if line is a standalone markdown link or standalone URL
    const unquoted = trimmed.replace(/^["']|["']$/g, '').trim();
    const standaloneMatch =
      unquoted.match(/^\[([^\]]+)\]\s*\((https?:\/\/[^\s)]+)\)$/) ||
      unquoted.match(/^(https?:\/\/[^\s<>)"]+)$/);

    if (standaloneMatch) {
      const linkText = standaloneMatch[2] ? standaloneMatch[1] : standaloneMatch[1];
      const href = standaloneMatch[2] || standaloneMatch[1];
      elements.push(renderStandaloneLinkCard(linkText, href, i));
      i++;
      continue;
    }

    // Normal paragraph
    elements.push(
      <p key={i} className="leading-relaxed text-slate-700 font-sans">
        {parseFormattedText(trimmed)}
      </p>
    );
    i++;
  }

  return elements;
}

/**
 * Render a prominent, interactive resource card for standalone document/slides/web links
 */
function renderStandaloneLinkCard(text: string, href: string, key: React.Key) {
  const isSlides = href.includes('presentation') || href.includes('slides.google.com');
  const isDocs = href.includes('/document/') || href.includes('docs.google.com/document');
  const isSheets = href.includes('/spreadsheets/') || href.includes('sheets.google.com');

  const badgeConfig = isSlides
    ? {
        label: 'Google Slides Presentation',
        icon: <Presentation className="w-5 h-5 text-amber-700 shrink-0" />,
        bg: 'bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/15',
        buttonBg: 'bg-amber-600 hover:bg-amber-700 text-white',
        accentColor: 'text-amber-950',
      }
    : isDocs
    ? {
        label: 'Google Docs Document',
        icon: <FileText className="w-5 h-5 text-blue-600 shrink-0" />,
        bg: 'bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/15',
        buttonBg: 'bg-blue-600 hover:bg-blue-700 text-white',
        accentColor: 'text-blue-950',
      }
    : isSheets
    ? {
        label: 'Google Sheets Spreadsheet',
        icon: <Table className="w-5 h-5 text-emerald-700 shrink-0" />,
        bg: 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/15',
        buttonBg: 'bg-emerald-700 hover:bg-emerald-800 text-white',
        accentColor: 'text-emerald-950',
      }
    : {
        label: 'External Resource',
        icon: <Globe className="w-5 h-5 text-slate-600 shrink-0" />,
        bg: 'bg-slate-50 border-slate-200 hover:bg-slate-100',
        buttonBg: 'bg-slate-800 hover:bg-slate-900 text-white',
        accentColor: 'text-slate-900',
      };

  let hostname = '';
  try {
    hostname = new URL(href).hostname;
  } catch {
    hostname = href;
  }

  const displayTitle =
    text && !text.startsWith('http')
      ? text
      : isSlides
      ? 'Google Slides Presentation'
      : isDocs
      ? 'Google Docs Document'
      : isSheets
      ? 'Google Sheets Spreadsheet'
      : hostname;

  return (
    <div
      key={key}
      className={`my-3 p-4 rounded-2xl border transition-all shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${badgeConfig.bg}`}
    >
      <div className="flex items-start sm:items-center gap-3.5 min-w-0">
        <div className="w-10 h-10 rounded-xl bg-white shadow-sm flex items-center justify-center shrink-0 border border-slate-200/60">
          {badgeConfig.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              {badgeConfig.label}
            </span>
          </div>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`font-bold text-sm hover:underline block ${badgeConfig.accentColor} truncate`}
            title={displayTitle}
          >
            {displayTitle}
          </a>
          <div className="text-[11px] text-slate-500 font-mono truncate">{hostname}</div>
        </div>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all shrink-0 hover:scale-[1.02] ${badgeConfig.buttonBg}`}
      >
        <span>Open</span>
        <ArrowUpRight className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

/**
 * Render inline clickable links with icons
 */
function renderInlineLink(text: string, href: string, key: React.Key) {
  if (providerIdFromConnectHref(href)) {
    return (
      <ConnectorSignInControl
        key={key}
        href={href}
        idleLabel={text}
        className="inline-flex items-center gap-1 text-amber-800 underline underline-offset-2 hover:text-amber-950 font-semibold bg-amber-500/10 hover:bg-amber-500/20 px-1.5 py-0.5 rounded transition-all mx-0.5"
      />
    );
  }

  const isExternal = href.startsWith('http://') || href.startsWith('https://');
  const isSlides = href.includes('presentation') || href.includes('slides.google.com');
  const isDocs = href.includes('/document/') || href.includes('docs.google.com/document');
  const isSheets = href.includes('/spreadsheets/') || href.includes('sheets.google.com');

  return (
    <a
      key={key}
      href={href}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
      className="inline-flex items-center gap-1 text-amber-800 underline underline-offset-2 hover:text-amber-950 font-semibold bg-amber-500/10 hover:bg-amber-500/20 px-1.5 py-0.5 rounded transition-all group mx-0.5"
    >
      {isSlides && <Presentation className="w-3.5 h-3.5 text-amber-700 shrink-0" />}
      {isDocs && <FileText className="w-3.5 h-3.5 text-blue-700 shrink-0" />}
      {isSheets && <Table className="w-3.5 h-3.5 text-emerald-700 shrink-0" />}
      {text}
      {isExternal && (
        <ExternalLink className="w-3 h-3 text-amber-700 opacity-75 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all shrink-0" />
      )}
    </a>
  );
}

/**
 * Helper to parse **bold**, `inline code`, [link text](url), and bare URLs inside strings
 */
function parseFormattedText(text: string): React.ReactNode[] {
  const tokens = text.split(/(\*\*[\s\S]*?\*\*|`[^`]+`|\[[^\]]+\]\s*\([^\s)]+\)|https?:\/\/[^\s<>)"]+)/g);

  return tokens.filter(Boolean).map((token, i) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      return (
        <strong key={i} className="font-bold text-heading">
          {parseFormattedText(token.slice(2, -2))}
        </strong>
      );
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code
          key={i}
          className="px-1.5 py-0.5 mx-0.5 rounded-md bg-cream-200 text-amber-800 font-mono text-[11px] font-semibold border border-cream-300"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith('[') && token.endsWith(')')) {
      const match = token.match(/^\[([^\]]+)\]\s*\(([^)\s]+)\)$/);
      if (match) {
        return renderInlineLink(match[1], match[2], i);
      }
    }
    if (token.startsWith('http://') || token.startsWith('https://')) {
      return renderInlineLink(token, token, i);
    }
    return token;
  });
}
