'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid,
  Sparkles,
  MessageSquare,
  Users,
  Lightbulb,
  BarChart3,
  Layers,
  Settings,
  Plug,
  LogOut,
  Brain,
  ListChecks,
  Building2,
  Inbox,
  CreditCard,
  Wand2,
} from 'lucide-react';
import { BottomTabs } from '@/components/a11y';

const NAV_ITEMS = [
  { href: '/', label: 'Home', icon: LayoutGrid },
  { href: '/ask-ai', label: 'Ask AI', icon: Sparkles },
  { href: '/conversations', label: 'Conversations', icon: MessageSquare },
  { href: '/plans', label: 'Plans', icon: ListChecks },
  { href: '/brain', label: 'Brain', icon: Brain },
  { href: '/listings', label: 'Listings', icon: Building2 },
  { href: '/inquiries', label: 'Inquiries', icon: Inbox },
  { href: '/employees', label: 'Employees', icon: Users },
  { href: '/insight', label: 'Insight', icon: Lightbulb },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/integrations', label: 'Integrations', icon: Layers },
  { href: '/connectors', label: 'Connectors', icon: Plug },
  { href: '/billing', label: 'Billing', icon: CreditCard },
  { href: '/skills', label: 'Skills', icon: Wand2 },
];

function ProfileAvatar() {
  const [user, setUser] = React.useState<{ email?: string; orgId?: string } | null>(null);

  React.useEffect(() => {
    fetch('/api/auth/session')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated) {
          setUser(data);
        }
      })
      .catch(console.error);
  }, []);

  if (!user || !user.email) return null;

  const initial = user.email.charAt(0).toUpperCase();

  return (
    <div className="w-12 h-12 rounded-full bg-amber-500 flex items-center justify-center text-heading font-bold shadow-md cursor-pointer group relative">
      {initial}
      <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
        <div className="flex flex-col">
          <span>{user.email}</span>
          <span className="text-slate-400 text-[10px]">{user.orgId}</span>
        </div>
      </span>
    </div>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  pathname,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  pathname: string | null;
}) {
  const isActive = pathname === href || (href !== '/' && pathname?.startsWith(href));
  return (
    <Link
      href={href}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      title={label}
      className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
        isActive
          ? 'bg-amber-500 text-heading shadow-md font-bold'
          : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
      }`}
    >
      <Icon className="w-5 h-5" />
      <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
        {label}
      </span>
    </Link>
  );
}

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const pathname = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      window.location.href = '/api/auth/signout';
    } catch {
      window.location.href = '/login';
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-cream-100">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-2 focus:bg-amber-500 focus:text-heading focus:rounded-xl"
      >
        Skip to content
      </a>

      <aside className="hidden md:flex w-18 bg-white border-r border-cream-300 flex-col items-center py-5 justify-between shrink-0 z-20">
        <div className="flex flex-col items-center space-y-6 min-h-0">
          <Link
            href="/"
            className="w-11 h-11 rounded-2xl bg-amber-500 flex items-center justify-center shadow-md hover:bg-amber-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            aria-label="DareX Home"
          >
            <span className="font-serif font-bold text-heading text-xl">D</span>
          </Link>

          <nav className="flex flex-col items-center space-y-3 overflow-y-auto pb-2" aria-label="Dashboard">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.href} {...item} pathname={pathname} />
            ))}
          </nav>
        </div>

        <div className="flex flex-col items-center space-y-3">
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
              pathname === '/settings'
                ? 'bg-amber-500 text-heading shadow-md'
                : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
            }`}
          >
            <Settings className="w-5 h-5" />
            <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
              Settings
            </span>
          </Link>

          <ProfileAvatar />

          <button
            onClick={handleLogout}
            disabled={loggingOut}
            aria-label="Sign out"
            title="Sign out"
            className="w-12 h-12 rounded-2xl flex items-center justify-center transition-all text-slate-400 hover:bg-red-50 hover:text-red-500 group relative disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            <LogOut className="w-5 h-5" />
            <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
              Sign out
            </span>
          </button>
        </div>
      </aside>

      <main id="main-content" className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8 relative pb-24 md:pb-8">
        {children}
      </main>

      <BottomTabs />
    </div>
  );
};
