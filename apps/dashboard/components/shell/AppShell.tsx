'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Sparkles, MessageSquare, Users, Lightbulb, BarChart3, Layers, Settings } from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Home', icon: LayoutGrid },
  { href: '/ask-ai', label: 'Ask AI', icon: Sparkles },
  { href: '/conversations', label: 'Conversations', icon: MessageSquare },
  { href: '/employees', label: 'Employees', icon: Users },
  { href: '/insight', label: 'Insight', icon: Lightbulb },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/integrations', label: 'Integrations', icon: Layers },
];

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const pathname = usePathname();

  return (
    <div className="flex h-screen overflow-hidden bg-cream-100">
      {/* Persistent Left Sidebar (~72px wide) */}
      <aside className="w-18 bg-white border-r border-cream-300 flex flex-col items-center py-5 justify-between shrink-0 z-20">
        {/* Brand Icon */}
        <div className="flex flex-col items-center space-y-6">
          <Link href="/" className="w-11 h-11 rounded-2xl bg-amber-500 flex items-center justify-center shadow-md hover:bg-amber-600 transition-colors">
            <span className="font-serif font-bold text-heading text-xl">D</span>
          </Link>

          {/* Navigation items */}
          <nav className="flex flex-col items-center space-y-3">
            {NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href));
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={item.label}
                  className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${
                    isActive
                      ? 'bg-amber-500 text-heading shadow-md font-bold'
                      : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Settings pinned to bottom */}
        <Link
          href="/settings"
          aria-label="Settings"
          className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${
            pathname === '/settings'
              ? 'bg-amber-500 text-heading shadow-md'
              : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
          }`}
        >
          <Settings className="w-5 h-5" />
        </Link>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto p-8 relative">
        {children}
      </main>
    </div>
  );
};
