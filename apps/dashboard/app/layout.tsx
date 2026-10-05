import type { Metadata } from 'next';
import './globals.css';
import { AliveBeacon } from '@/components/AliveBeacon';
import { LOAD_GUARD_SCRIPT } from '@/lib/load-guard';

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
      <head>
        <script dangerouslySetInnerHTML={{ __html: LOAD_GUARD_SCRIPT }} />
      </head>
      <body className="bg-cream-100 min-h-screen text-heading antialiased">
        <AliveBeacon />
        {children}
      </body>
    </html>
  );
}
