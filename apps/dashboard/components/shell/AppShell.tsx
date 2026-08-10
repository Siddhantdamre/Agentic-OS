'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
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
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', label: 'Home', icon: LayoutGrid },
  { href: '/ask-ai', label: 'Ask AI', icon: Sparkles },
  { href: '/conversations', label: 'Conversations', icon: MessageSquare },
  { href: '/employees', label: 'Employees', icon: Users },
  { href: '/insight', label: 'Insight', icon: Lightbulb },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/integrations', label: 'Integrations', icon: Layers },
  { href: '/connectors', label: 'Connectors', icon: Plug },
];

function ProfileAvatar() {
  const [user, setUser] = React.useState<{ email?: string; orgId?: string } | null>(null);

  React.useEffect(() => {
    fetch('/api/auth/session')
      .then(res => res.json())
      .then(data => {
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

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      // Use full page navigation to /api/auth/signout so server can delete cookies via redirect
      window.location.href = '/api/auth/signout';
    } catch {
      window.location.href = '/login';
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-cream-100">
      {/* Persistent Left Sidebar (~72px wide) */}
      <aside className="w-18 bg-white border-r border-cream-300 flex flex-col items-center py-5 justify-between shrink-0 z-20">
        {/* Brand Icon + Nav */}
        <div className="flex flex-col items-center space-y-6">
          <Link
            href="/"
            className="w-11 h-11 rounded-2xl bg-amber-500 flex items-center justify-center shadow-md hover:bg-amber-600 transition-colors"
            aria-label="DareX Home"
          >
            <span className="font-serif font-bold text-heading text-xl">D</span>
          </Link>

          {/* Navigation items */}
          <nav className="flex flex-col items-center space-y-3">
            {NAV_ITEMS.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== '/' && pathname?.startsWith(item.href));
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={item.label}
                  title={item.label}
                  className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative ${
                    isActive
                      ? 'bg-amber-500 text-heading shadow-md font-bold'
                      : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  {/* Tooltip */}
                  <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom: Settings + Profile + Logout */}
        <div className="flex flex-col items-center space-y-3">
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative ${
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

          {/* User Profile Avatar */}
          <ProfileAvatar />

          <button
            onClick={handleLogout}
            disabled={loggingOut}
            aria-label="Sign out"
            title="Sign out"
            className="w-12 h-12 rounded-2xl flex items-center justify-center transition-all text-slate-400 hover:bg-red-50 hover:text-red-500 group relative disabled:opacity-50"
          >
            <LogOut className="w-5 h-5" />
            <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
              Sign out
            </span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto p-8 relative">
        {children}
      </main>
    </div>
  );
};
