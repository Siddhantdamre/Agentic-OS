'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  Sparkles,
  MessageSquare,
  Users,
  Brain,
} from 'lucide-react';

const TABS = [
  { href: '/', label: 'Home', icon: LayoutGrid },
  { href: '/ask-ai', label: 'Ask AI', icon: Sparkles },
  { href: '/conversations', label: 'Inbox', icon: MessageSquare },
  { href: '/employees', label: 'Team', icon: Users },
  { href: '/brain', label: 'Brain', icon: Brain },
] as const;

export function BottomTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t border-cream-300 safe-bottom"
    >
      <ul className="grid grid-cols-5">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive =
            pathname === tab.href || (tab.href !== '/' && pathname?.startsWith(tab.href));
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? 'page' : undefined}
                className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  isActive ? 'text-heading' : 'text-slate-500'
                }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? 'text-amber-600' : ''}`} aria-hidden="true" />
                <span>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
