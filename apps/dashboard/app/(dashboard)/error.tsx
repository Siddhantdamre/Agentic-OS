'use client';

import { useEffect } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard route error:', error);
  }, [error]);

  return (
    <div className="flex-1 p-6 md:p-8 flex items-center justify-center min-h-[60vh]">
      <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-cream-300 dark:border-slate-800 rounded-3xl p-8 text-center shadow-sm">
        <div className="w-12 h-12 rounded-2xl bg-amber-100 dark:bg-amber-950/50 flex items-center justify-center mx-auto mb-4 text-amber-700 dark:text-amber-400">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h2 className="text-xl font-serif font-bold text-heading dark:text-white">
          This tab failed to load
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">
          An error occurred while loading this section. Your workspace session and other tabs remain safe.
        </p>
        {error.digest ? (
          <p className="text-xs text-slate-400 font-mono mt-3">Ref: {error.digest}</p>
        ) : null}
        <button
          type="button"
          onClick={() => reset()}
          className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl bg-amber-500 hover:bg-amber-600 text-heading transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Try reloading tab
        </button>
      </div>
    </div>
  );
}
