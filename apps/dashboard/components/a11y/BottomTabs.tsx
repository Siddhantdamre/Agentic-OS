'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  Sparkles,
  MessageSquare,
  Users,
  MoreHorizontal,
} from 'lucide-react';

const TABS = [
  { href: '/', label: 'Home', icon: LayoutGrid },
  { href: '/ask-ai', label: 'Ask AI', icon: Sparkles },
  { href: '/conversations', label: 'Inbox', icon: MessageSquare },
  { href: '/employees', label: 'Employees', icon: Users },
] as const;

const MORE = [
  { href: '/brief', label: 'Brief' },
  { href: '/insight', label: 'Insight' },
  { href: '/inquiries', label: 'Inquiries' },
  { href: '/brain', label: 'Brain' },
  { href: '/plans', label: 'Plans' },
  { href: '/work-items', label: 'Work items' },
  { href: '/listings', label: 'Listings' },
  { href: '/growth', label: 'Growth' },
  { href: '/employees/customer', label: 'Customer' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/observability', label: 'Health' },
  { href: '/audit', label: 'Audit' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/connectors', label: 'Connectors' },
  { href: '/packs', label: 'Packs' },
  { href: '/billing', label: 'Billing' },
  { href: '/skills', label: 'Skills' },
  { href: '/settings/autonomy', label: 'Autonomy' },
  { href: '/settings', label: 'Settings' },
] as const;

export function BottomTabs() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE.some(
    (item) => pathname === item.href || pathname?.startsWith(`${item.href}/`)
  );

  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 backdrop-blur border-t border-cream-300 pb-[env(safe-area-inset-bottom)]"
    >
      {moreOpen ? (
        <ul className="grid grid-cols-2 gap-1 p-3 border-b border-cream-200 bg-white max-h-64 overflow-y-auto">
          {MORE.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={() => setMoreOpen(false)}
                className="block rounded-lg px-3 py-2 text-sm font-semibold text-heading hover:bg-cream-100"
              >
                {item.label}
              </Link>
            </li>
          ))}
          <li>
            <a
              href="/api/auth/signout"
              className="block rounded-lg px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
            >
              Sign out
            </a>
          </li>
        </ul>
      ) : null}
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
                onClick={() => setMoreOpen(false)}
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
        <li>
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className={`w-full flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-semibold ${
              moreActive || moreOpen ? 'text-heading' : 'text-slate-500'
            }`}
          >
            <MoreHorizontal className={`w-5 h-5 ${moreActive || moreOpen ? 'text-amber-600' : ''}`} aria-hidden="true" />
            <span>More</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
