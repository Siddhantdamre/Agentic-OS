'use client';

import { useEffect } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-[50vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border border-cream-300 rounded-3xl p-8 text-center shadow-sm">
        <h1 className="text-2xl font-serif font-bold text-heading">Something went wrong</h1>
        <p className="text-sm text-slate-500 mt-2">
          This page failed to render. Your other workspaces and tabs are unchanged.
        </p>
        {error.digest ? (
          <p className="text-xs text-slate-400 mt-3">Reference {error.digest}</p>
        ) : null}
        <button
          type="button"
          onClick={() => reset()}
          className="mt-6 px-4 py-2 text-sm font-bold rounded-lg bg-amber-500 hover:bg-amber-600 text-heading"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
