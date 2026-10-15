import React from 'react';
import Link from 'next/link';

export type LegalSection = { heading: string; body: string[] };

/**
 * One readable page for a legal document. Plain server-rendered text on the same dark theme as sign-in, so it
 * opens instantly, prints cleanly and works with no script.
 */
export function LegalDocument({
  title,
  updated,
  sections,
  other,
}: {
  title: string;
  updated: string;
  sections: LegalSection[];
  other: { href: string; label: string };
}) {
  return (
    <main className="min-h-screen bg-[#0C1311] text-[#FAF9F0] px-4 py-10 font-sans">
      <article className="mx-auto max-w-2xl">
        <p className="text-xs text-emerald-300/70">
          <Link href="/register" className="text-[#F0C05A] hover:underline">Back to sign up</Link>
        </p>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-1 text-xs text-emerald-300/70">Last updated {updated}</p>
        <p
          role="note"
          className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-100"
        >
          This is a plain-language draft that has not yet been reviewed by a lawyer. It describes what the product does
          today.
        </p>
        {sections.map((s) => (
          <section key={s.heading} className="mt-8">
            <h2 className="text-lg font-bold text-emerald-50">{s.heading}</h2>
            {s.body.map((p) => (
              <p key={p} className="mt-2 text-sm leading-relaxed text-emerald-100/90">{p}</p>
            ))}
          </section>
        ))}
        <p className="mt-10 text-xs text-emerald-300/70">
          See also the{' '}
          <Link href={other.href} className="text-[#F0C05A] hover:underline">{other.label}</Link>.
        </p>
      </article>
    </main>
  );
}
