'use client';

import React, { Component, ReactNode, useState, useId, useEffect } from 'react';
import { Renderer } from '@openuidev/react-lang';
import { ThemeProvider, openuiLibrary } from '@openuidev/react-ui';
import { LayoutGrid, AlertTriangle, Code2, Sun, Moon } from 'lucide-react';

interface ErrorBoundaryProps {
  fallback: (error: Error) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class OpenUiErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}

export interface OpenUiFenceBlockProps {
  content: string;
  isStreaming?: boolean;
  darkTheme?: boolean;
}

export const OpenUiFenceBlock: React.FC<OpenUiFenceBlockProps> = ({
  content,
  isStreaming = false,
  darkTheme = false,
}) => {
  const [showRaw, setShowRaw] = useState(false);
  const [isDark, setIsDark] = useState<boolean>(darkTheme);
  const rawId = useId();
  const scopeId = 'openui-scope-' + rawId.replace(/[^a-zA-Z0-9_-]/g, '');

  useEffect(() => {
    setIsDark(darkTheme);
  }, [darkTheme]);

  if (!content) return null;

  return (
    <div
      className={`aui-openui my-3 w-full min-w-0 max-w-full rounded-2xl border p-4 shadow-sm backdrop-blur-sm transition-colors ${
        isDark
          ? 'border-slate-800 bg-slate-900 text-slate-100'
          : 'border-cream-300 bg-white/95 text-slate-900'
      }`}
    >
      <div
        className={`mb-3 flex items-center justify-between border-b pb-2 text-[11px] font-medium transition-colors ${
          isDark
            ? 'border-slate-800 text-slate-400'
            : 'border-cream-200 text-slate-600'
        }`}
      >
        <div className="flex items-center gap-2">
          <div
            className={`flex h-5 w-5 items-center justify-center rounded-md ${
              isDark
                ? 'bg-amber-950/60 text-amber-400'
                : 'bg-amber-100 text-amber-700'
            }`}
          >
            <LayoutGrid className="h-3 w-3" />
          </div>
          <span
            className={`font-mono text-[10px] font-semibold uppercase tracking-wider ${
              isDark ? 'text-slate-200' : 'text-slate-800'
            }`}
          >
            Interactive OpenUI Widget
          </span>
          {isStreaming && (
            <span
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-medium ${
                isDark
                  ? 'bg-amber-950/40 text-amber-400'
                  : 'bg-amber-50 text-amber-700 border border-amber-200/60'
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
              Streaming
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsDark(!isDark)}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-sans transition-colors ${
              isDark
                ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                : 'text-slate-600 hover:bg-cream-100 hover:text-slate-900'
            }`}
            title={isDark ? 'Switch to light widget theme' : 'Switch to dark widget theme'}
            aria-label={isDark ? 'Switch to light widget theme' : 'Switch to dark widget theme'}
          >
            {isDark ? (
              <>
                <Sun className="h-3 w-3 text-amber-400" />
                <span>Light</span>
              </>
            ) : (
              <>
                <Moon className="h-3 w-3 text-slate-500" />
                <span>Dark</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowRaw(!showRaw)}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-sans transition-colors ${
              isDark
                ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                : 'text-slate-600 hover:bg-cream-100 hover:text-slate-900'
            }`}
            title="Toggle raw OpenUI definition"
          >
            <Code2 className="h-3 w-3" />
            <span>{showRaw ? 'Show Widget' : 'View Code'}</span>
          </button>
        </div>
      </div>

      {showRaw ? (
        <pre className="max-h-72 overflow-auto rounded-xl bg-slate-950 p-3 font-mono text-[11px] text-emerald-300">
          <code>{content}</code>
        </pre>
      ) : (
        <OpenUiErrorBoundary
          fallback={(err) => (
            <div
              className={`rounded-xl border p-3 text-xs ${
                isDark
                  ? 'border-red-900/50 bg-red-950/30 text-red-300'
                  : 'border-red-200 bg-red-50/70 text-red-700'
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
                <span>OpenUI component rendering failed: {err.message}</span>
              </div>
              <pre
                className={`mt-2 max-h-40 overflow-auto rounded p-2 font-mono text-[10px] ${
                  isDark
                    ? 'bg-black/50 text-slate-200'
                    : 'bg-white/80 text-slate-800 border border-red-200/50'
                }`}
              >
                <code>{content}</code>
              </pre>
            </div>
          )}
        >
          <ThemeProvider mode={isDark ? 'dark' : 'light'} cssSelector={`.${scopeId}`}>
            <div
              className={`${scopeId} markdown-openui-scope min-w-0 w-full max-w-full overflow-x-auto ${
                isDark ? 'openui-dark text-slate-100' : 'openui-light text-slate-900'
              }`}
            >
              <Renderer response={content} library={openuiLibrary} isStreaming={isStreaming} />
            </div>
          </ThemeProvider>
        </OpenUiErrorBoundary>
      )}
    </div>
  );
};
