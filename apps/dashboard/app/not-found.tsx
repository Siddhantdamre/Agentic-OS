import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-[50vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border border-cream-300 rounded-3xl p-8 text-center shadow-sm">
        <h1 className="text-2xl font-serif font-bold text-heading">Page not found</h1>
        <p className="text-sm text-slate-500 mt-2">That address is not part of this workspace.</p>
        <Link
          href="/"
          className="inline-block mt-6 px-4 py-2 text-sm font-bold rounded-lg bg-amber-500 hover:bg-amber-600 text-heading"
        >
          Go home
        </Link>
      </div>
    </div>
  );
}
