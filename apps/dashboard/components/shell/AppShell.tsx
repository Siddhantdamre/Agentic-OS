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
  HeartPulse,
  Target,
  Sun,
  ShieldCheck,
  BadgeCheck,
  HeartHandshake,
  CheckSquare,
  Package,
  ScrollText,
  ClipboardCheck,
  CalendarDays,
  ChevronDown,
  HandCoins,
} from 'lucide-react';
import { BottomTabs } from '@/components/a11y';
import { SystemDegradationBanner } from '@/components/SystemDegradationBanner';
import { ImpersonationBanner } from '@/components/platform/ImpersonationBanner';
import { OrganizationSwitcher } from '@/components/shell/OrganizationSwitcher';
import { usePendingApprovalCount } from '@/lib/use-pending-approvals';
import { usePrefetchOnIntent } from '@/lib/use-prefetch-on-intent';

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }> };

/** Pages grouped by what a person is doing, with names written out. `label: null` = the everyday core, no heading. */
const NAV_GROUPS: Array<{ id: string; label: string | null; items: NavItem[] }> = [
  {
    id: 'main',
    label: null,
    items: [
      { href: '/', label: 'Home', icon: LayoutGrid },
      { href: '/ask-ai', label: 'Ask AI', icon: Sparkles },
      { href: '/approvals', label: 'Approvals', icon: ClipboardCheck },
      { href: '/conversations', label: 'Inbox', icon: MessageSquare },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    items: [
      { href: '/dues', label: 'Money owed', icon: HandCoins },
      { href: '/work-items', label: 'Work Items', icon: CheckSquare },
      { href: '/plans', label: 'Plans', icon: ListChecks },
      { href: '/inquiries', label: 'Inquiries', icon: Inbox },
      { href: '/listings', label: 'Listings', icon: Building2 },
      { href: '/showings', label: 'Showings', icon: CalendarDays },
    ],
  },
  {
    id: 'team',
    label: 'Your team',
    items: [
      { href: '/employees', label: 'Employees', icon: Users },
      { href: '/employees/customer', label: 'Customer', icon: HeartHandshake },
      { href: '/growth', label: 'Growth', icon: Target },
      { href: '/skills', label: 'Skills', icon: Wand2 },
      { href: '/settings/autonomy', label: 'Autonomy', icon: ShieldCheck },
      { href: '/trust', label: 'Trust', icon: BadgeCheck },
    ],
  },
  {
    id: 'know',
    label: 'Knowledge and reports',
    items: [
      { href: '/brain', label: 'Brain', icon: Brain },
      { href: '/brief', label: 'Brief', icon: Sun },
      { href: '/insight', label: 'Insight', icon: Lightbulb },
      { href: '/analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    id: 'watch',
    label: 'Oversight',
    items: [
      { href: '/observability', label: 'Health', icon: HeartPulse },
      { href: '/audit', label: 'Audit', icon: ScrollText },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    items: [
      { href: '/connectors', label: 'Connectors', icon: Plug },
      { href: '/integrations', label: 'Integrations', icon: Layers },
      { href: '/packs', label: 'Packs', icon: Package },
      { href: '/billing', label: 'Billing', icon: CreditCard },
    ],
  },
];

const ALL_NAV_HREFS = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
/** Groups folded the first time. The everyday ones stay open; a person's own choice is remembered. */
const DEFAULT_CLOSED = ['team', 'know', 'watch', 'setup'];
const CLOSED_KEY = 'darex.nav.closed';

/** The one page being viewed: the longest link that matches, so "Customer" does not also light up "Employees". */
function activeHref(pathname: string | null): string | null {
  if (!pathname) return null;
  const hits = ALL_NAV_HREFS.filter((h) => pathname === h || (h !== '/' && pathname.startsWith(`${h}/`)));
  return hits.sort((a, b) => b.length - a.length)[0] ?? null;
}

function readClosed(): string[] {
  try {
    const raw = window.localStorage.getItem(CLOSED_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : DEFAULT_CLOSED;
  } catch {
    return DEFAULT_CLOSED;
  }
}

function writeClosed(closed: string[]): void {
  try {
    window.localStorage.setItem(CLOSED_KEY, JSON.stringify(closed));
  } catch {
    /* a browser that will not store anything just forgets the choice */
  }
}

type Session = { authenticated?: boolean; email?: string; orgId?: string; isPlatformAdmin?: boolean };

function ProfileAvatar({ user }: { user: Session | null }) {
  if (!user || !user.email) return null;
  const initial = user.email.charAt(0).toUpperCase();
  return (
    <div className="w-12 h-12 lg:w-full lg:h-auto lg:py-1.5 lg:px-3 rounded-2xl lg:rounded-xl bg-amber-500 lg:bg-transparent flex items-center justify-center lg:justify-start lg:gap-3 text-heading font-bold shadow-sm lg:shadow-none cursor-default group relative">
      <span className="lg:w-8 lg:h-8 lg:rounded-xl lg:bg-amber-500 lg:flex lg:items-center lg:justify-center lg:shrink-0">{initial}</span>
      <span data-nav-label className="hidden lg:block min-w-0 text-xs font-medium text-slate-600 truncate">{user.email}</span>
      <span aria-hidden="true" className="lg:hidden absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
        {user.email}
      </span>
    </div>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  folded,
  badge,
  onIntent,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** This is the page being viewed. */
  active: boolean;
  /** Its group is folded: hidden, on the wide sidebar and on the narrow icon rail alike. */
  folded: boolean;
  /** A number waiting for the person, shown on the icon. Nothing when zero or unknown. */
  badge?: number | null;
  /** Called when the person hovers or focuses the link, to load that page ahead of the click. */
  onIntent?: (href: string) => void;
}) {
  const waiting = badge && badge > 0 ? badge : 0;
  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={() => onIntent?.(href)}
      onFocus={() => onIntent?.(href)}
      aria-label={waiting ? `${label}, ${waiting} waiting` : label}
      aria-current={active ? 'page' : undefined}
      data-folded={folded ? 'true' : 'false'}
      title={label}
      className={`${folded ? 'hidden' : ''} w-12 h-12 lg:w-full lg:h-9 rounded-2xl lg:rounded-xl flex items-center justify-center lg:justify-start lg:gap-3 lg:px-3 transition-all group relative focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
        active
          ? 'bg-amber-500 text-heading shadow-md font-bold'
          : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
      }`}
    >
      <Icon className="w-5 h-5 shrink-0" />
      <span data-nav-label className="hidden lg:inline text-sm font-medium truncate">{label}</span>
      {waiting ? (
        <span aria-hidden="true" className="absolute -top-1 -right-1 lg:top-1/2 lg:-translate-y-1/2 lg:right-2 min-w-[1.25rem] h-5 px-1 rounded-full bg-red-600 text-white text-[11px] font-bold flex items-center justify-center">
          {waiting > 9 ? '9+' : waiting}
        </span>
      ) : null}
      <span aria-hidden="true" className="lg:hidden absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
        {label}
      </span>
    </Link>
  );
}

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const pathname = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const isPlatformAdmin = Boolean(session?.isPlatformAdmin);
  const pendingApprovals = usePendingApprovalCount();
  const prefetchOnIntent = usePrefetchOnIntent();
  const [closed, setClosed] = useState<string[]>(DEFAULT_CLOSED);
  const current = activeHref(pathname);
  React.useEffect(() => { setClosed(readClosed()); }, []);
  // The page you are on must be visible in the list: when its group is far down, bring it into view.
  React.useEffect(() => {
    const t = setTimeout(() => {
      const el = document.querySelector('nav[aria-label="Dashboard"] [aria-current="page"]') as HTMLElement | null;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }, 0);
    return () => clearTimeout(t);
  }, [current, session]); // the footer grows once the session arrives, which shortens the list
  const toggleGroup = (id: string) => {
    setClosed((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      writeClosed(next);
      return next;
    });
  };

  // One session request for the whole shell (the avatar and the platform banner both need it).
  React.useEffect(() => {
    fetch('/api/auth/session')
      .then((res) => res.json())
      .then((data: Session) => {
        if (data && data.authenticated) setSession(data);
      })
      .catch(() => {});
  }, []);

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

      <aside className="hidden md:flex w-20 lg:w-60 bg-white border-r border-cream-300 flex-col items-center py-4 justify-between shrink-0 z-20 h-screen select-none">
        <div className="flex flex-col items-center lg:items-stretch space-y-4 min-h-0 w-full flex-1 overflow-hidden">
          <Link
            href="/"
            prefetch={false}
            className="w-11 h-11 rounded-2xl bg-amber-500 flex items-center justify-center shadow-md hover:bg-amber-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 shrink-0"
            aria-label="DareX Home"
          >
            <span className="font-serif font-bold text-heading text-xl">D</span>
          </Link>

          <OrganizationSwitcher />

          <nav className="flex flex-col items-center lg:items-stretch gap-0.5 overflow-y-auto overflow-x-hidden w-full px-2 py-1 scrollbar-none" aria-label="Dashboard">
            {NAV_GROUPS.map((group) => {
              const holdsCurrent = group.items.some((i) => i.href === current);
              const folded = group.label !== null && closed.includes(group.id) && !holdsCurrent;
              const listId = `nav-group-${group.id}`;
              return (
                <div key={group.id} className="flex flex-col items-center lg:items-stretch gap-0.5 w-full">
                  {group.label ? (
                    <>
                      <button
                        type="button"
                        aria-label={`${folded ? 'Show' : 'Hide'} ${group.label} pages`}
                        title={`${folded ? 'Show' : 'Hide'} ${group.label}`}
                        aria-expanded={!folded}
                        aria-controls={listId}
                        onClick={() => toggleGroup(group.id)}
                        className="lg:hidden flex h-6 w-12 items-center justify-center rounded-lg border-t border-cream-300 text-slate-400 hover:text-heading focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      >
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${folded ? '-rotate-90' : ''}`} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-expanded={!folded}
                        aria-controls={listId}
                        onClick={() => toggleGroup(group.id)}
                        className="hidden lg:flex items-center justify-between rounded-lg px-3 pt-2 pb-0.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:text-heading focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                      >
                        <span>{group.label}</span>
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${folded ? '-rotate-90' : ''}`} aria-hidden="true" />
                      </button>
                    </>
                  ) : null}
                  <div id={listId} className="flex flex-col items-center lg:items-stretch gap-0.5 w-full">
                    {group.items.map((item) => (
                      <NavLink
                        key={item.href}
                        {...item}
                        active={item.href === current}
                        folded={folded}
                        badge={item.href === '/approvals' ? pendingApprovals : null}
                        onIntent={prefetchOnIntent}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-col items-center lg:items-stretch space-y-2.5 lg:space-y-0.5 shrink-0 pt-2 border-t border-cream-200/80 w-full px-2">
          <Link
            href="/settings"
            prefetch={false}
            onMouseEnter={() => prefetchOnIntent('/settings')}
            onFocus={() => prefetchOnIntent('/settings')}
            aria-label="Settings"
            title="Settings"
            className={`w-12 h-12 lg:w-full lg:h-9 rounded-2xl lg:rounded-xl flex items-center justify-center lg:justify-start lg:gap-3 lg:px-3 transition-all group relative focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
              pathname === '/settings'
                ? 'bg-amber-500 text-heading shadow-md'
                : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
            }`}
          >
            <Settings className="w-5 h-5 shrink-0" />
            <span data-nav-label className="hidden lg:inline text-sm font-medium">Settings</span>
            <span aria-hidden="true" className="lg:hidden absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
              Settings
            </span>
          </Link>

          <ProfileAvatar user={session} />

          <button
            onClick={handleLogout}
            disabled={loggingOut}
            aria-label="Sign out"
            title="Sign out"
            className="w-12 h-12 lg:w-full lg:h-9 rounded-2xl lg:rounded-xl flex items-center justify-center lg:justify-start lg:gap-3 lg:px-3 transition-all text-slate-400 hover:bg-red-50 hover:text-red-500 group relative disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          >
            <LogOut className="w-5 h-5 shrink-0" />
            <span data-nav-label className="hidden lg:inline text-sm font-medium">Sign out</span>
            <span aria-hidden="true" className="lg:hidden absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg">
              Sign out
            </span>
          </button>
        </div>
      </aside>

      <main id="main-content" className="flex-1 overflow-y-auto relative pb-24 md:pb-8 flex flex-col min-w-0">
        {isPlatformAdmin && <ImpersonationBanner />}
        <SystemDegradationBanner />
        <div className="flex-1 p-4 sm:p-6 md:p-8">{children}</div>
      </main>

      <BottomTabs />
    </div>
  );
};
