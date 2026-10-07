'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  Sparkles,
  MessageSquare,
  ClipboardCheck,
  MoreHorizontal,
} from 'lucide-react';
import { usePendingApprovalCount } from '@/lib/use-pending-approvals';
import { usePrefetchOnIntent } from '@/lib/use-prefetch-on-intent';

const TABS = [
  { href: '/', label: 'Home', icon: LayoutGrid },
  { href: '/ask-ai', label: 'Ask AI', icon: Sparkles },
  { href: '/approvals', label: 'Approvals', icon: ClipboardCheck },
  { href: '/conversations', label: 'Inbox', icon: MessageSquare },
] as const;

const MORE = [
  { href: '/employees', label: 'Employees' },
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
  { href: '/trust', label: 'Trust' },
  { href: '/settings', label: 'Settings' },
] as const;

export function BottomTabs() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const pending = usePendingApprovalCount();
  const prefetchOnIntent = usePrefetchOnIntent();
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
                prefetch={false}
                onTouchStart={() => prefetchOnIntent(item.href)}
                onClick={() => setMoreOpen(false)}
                className="block rounded-lg px-3 py-2 text-sm font-semibold text-heading hover:bg-cream-100"
              >
                {item.label}
              </Link>
            </li>
          ))}
          <li>
            {/* API endpoint, not a page: a <Link> would prefetch the sign-out. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
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
                prefetch={false}
                onTouchStart={() => prefetchOnIntent(tab.href)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={tab.href === '/approvals' && pending && pending > 0 ? `${tab.label}, ${pending} waiting` : undefined}
                onClick={() => setMoreOpen(false)}
                className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  isActive ? 'text-heading' : 'text-slate-500'
                }`}
              >
                <span className="relative">
                  <Icon className={`w-5 h-5 ${isActive ? 'text-amber-600' : ''}`} aria-hidden="true" />
                  {tab.href === '/approvals' && pending && pending > 0 ? (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                      {pending > 9 ? '9+' : pending}
                    </span>
                  ) : null}
                </span>
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
