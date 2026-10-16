import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const prefetch = jest.fn();
jest.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ prefetch, push: jest.fn() }) }));
const linkProps: Array<Record<string, unknown>> = [];
jest.mock('next/link', () => {
  const MockLink = ({ children, href, prefetch: p, onMouseEnter, onFocus, onTouchStart, ...rest }: Record<string, unknown> & { children: React.ReactNode; href: string }) => {
    linkProps.push({ href, prefetch: p });
    return <a href={href} onMouseEnter={onMouseEnter as never} onFocus={onFocus as never} onTouchStart={onTouchStart as never} {...(rest as object)}>{children}</a>;
  };
  MockLink.displayName = 'MockLink';
  return MockLink;
});
jest.mock('@/components/SystemDegradationBanner', () => ({ SystemDegradationBanner: () => null }));
jest.mock('@/components/platform/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));
jest.mock('@/components/shell/OrganizationSwitcher', () => ({ OrganizationSwitcher: () => null }));
jest.mock('@/lib/use-pending-approvals', () => ({ usePendingApprovalCount: () => 0 }));

import { AppShell } from '../AppShell';

beforeEach(() => {
  prefetch.mockClear(); linkProps.length = 0;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ authenticated: false }) }) as Response) as unknown as typeof fetch;
});

describe('the sidebar does not load every page up front', () => {
  it('turns off automatic prefetching for every link it draws', () => {
    render(<AppShell><div /></AppShell>);
    const nav = linkProps.filter((l) => String(l.href).startsWith('/'));
    expect(nav.length).toBeGreaterThan(20);
    // Next prefetches every visible link by default: 21 requests and every other page's code, on every page load.
    expect(nav.every((l) => l.prefetch === false)).toBe(true);
  });

  it('loads a page ahead of time only when the person shows they are about to open it', () => {
    render(<AppShell><div /></AppShell>);
    expect(prefetch).not.toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Brain' }));
    expect(prefetch).toHaveBeenCalledWith('/brain');
    fireEvent.focus(screen.getByRole('link', { name: 'Listings' }));
    expect(prefetch).toHaveBeenCalledWith('/listings');
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it('does not ask twice for the same page', () => {
    render(<AppShell><div /></AppShell>);
    const brain = screen.getByRole('link', { name: 'Brain' });
    fireEvent.mouseEnter(brain); fireEvent.mouseEnter(brain); fireEvent.focus(brain);
    expect(prefetch).toHaveBeenCalledTimes(1);
  });
});
