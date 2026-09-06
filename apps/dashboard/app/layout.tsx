import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DareX ai — AI Employees for Business',
  description: 'Multi-tenant AI-employee SaaS platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-cream-100 min-h-screen text-heading antialiased">
        {/* Skip link. A keyboard or screen-reader user otherwise tabs through
            the whole sidebar on every page load before reaching the content.
            Visually hidden until focused, so it costs sighted users nothing. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-4 focus:py-2 focus:text-heading focus:shadow-lg"
        >
          Skip to main content
        </a>
        <div id="main">{children}</div>
      </body>
    </html>
  );
}
