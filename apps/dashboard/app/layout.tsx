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
        {children}
      </body>
    </html>
  );
}
