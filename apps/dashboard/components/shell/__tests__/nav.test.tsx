import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';

let mockPath = '/';
jest.mock('next/navigation', () => ({ usePathname: () => mockPath, useRouter: () => ({ prefetch: jest.fn(), push: jest.fn() }) }));
jest.mock('next/link', () => {
  const MockLink = ({ children, href, prefetch: _p, ...rest }: Record<string, unknown> & { children: React.ReactNode; href: string }) => <a href={href} {...(rest as object)}>{children}</a>;
  MockLink.displayName = 'MockLink';
  return MockLink;
});
jest.mock('@/components/SystemDegradationBanner', () => ({ SystemDegradationBanner: () => null }));
jest.mock('@/components/platform/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));
jest.mock('@/components/shell/OrganizationSwitcher', () => ({ OrganizationSwitcher: () => null }));
let mockApprovals: number | null = 0;
jest.mock('@/lib/use-pending-approvals', () => ({ usePendingApprovalCount: () => mockApprovals }));

import { AppShell } from '../AppShell';

const KEY = 'darex.nav.closed';
const sidebar = () => screen.getByRole('navigation', { name: 'Dashboard' });

beforeEach(() => {
  mockPath = '/'; mockApprovals = 0;
  try { window.localStorage.clear(); } catch { /* none */ }
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ authenticated: false }) }) as Response) as unknown as typeof fetch;
});

describe('sidebar', () => {
  it('groups the pages under plain headings, so 23 icons become five short lists', () => {
    render(<AppShell><div /></AppShell>);
    for (const heading of ['Work', 'Your team', 'Knowledge and reports', 'Oversight', 'Setup']) {
      expect(within(sidebar()).getByRole('button', { name: heading })).toBeInTheDocument();
    }
  });

  it('writes the name of every page next to its icon, not only in a tooltip', () => {
    render(<AppShell><div /></AppShell>);
    const links = within(sidebar()).getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(24);
    for (const link of links) {
      // A visible label (not aria-hidden): an icon alone made a new person hover 23 buttons to learn what they were.
      const label = link.querySelector('[data-nav-label]');
      expect(label).not.toBeNull();
      expect(label!.getAttribute('aria-hidden')).toBeNull();
      expect((label!.textContent || '').trim().length).toBeGreaterThan(1);
    }
  });

  it('highlights one page, the one you are on, not its parent as well', () => {
    mockPath = '/employees/customer';
    render(<AppShell><div /></AppShell>);
    const current = within(sidebar()).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.getAttribute('href'))).toEqual(['/employees/customer']);
  });

  it('includes the pages that had no way in: Showings', () => {
    render(<AppShell><div /></AppShell>);
    expect(within(sidebar()).getByRole('link', { name: 'Showings' })).toHaveAttribute('href', '/showings');
  });

  it('keeps Approvals near the top, with its count', () => {
    mockApprovals = 3;
    render(<AppShell><div /></AppShell>);
    const names = within(sidebar()).getAllByRole('link').map((a) => a.getAttribute('aria-label') || a.textContent);
    expect(names.slice(0, 4)).toEqual(['Home', 'Ask AI', 'Approvals, 3 waiting', 'Inbox']);
  });

  it('starts with the everyday groups open and the rest folded, and a click opens or folds one', () => {
    render(<AppShell><div /></AppShell>);
    const employees = within(sidebar()).getByRole('link', { name: 'Employees' });
    expect(employees).toHaveAttribute('data-folded', 'true');
    expect(within(sidebar()).getByRole('link', { name: 'Listings' })).toHaveAttribute('data-folded', 'false');
    const team = within(sidebar()).getByRole('button', { name: 'Your team' });
    expect(team).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(team);
    expect(team).toHaveAttribute('aria-expanded', 'true');
    expect(employees).toHaveAttribute('data-folded', 'false');
  });

  it('folds and opens the same groups from the narrow icon rail, which would otherwise scroll 27 unlabelled icons', () => {
    render(<AppShell><div /></AppShell>);
    const employees = within(sidebar()).getByRole('link', { name: 'Employees' });
    expect(employees).toHaveAttribute('data-folded', 'true');
    expect(employees.className).toMatch(/(^|\s)hidden(\s|$)/);
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'Show Your team pages' }));
    expect(employees).toHaveAttribute('data-folded', 'false');
    expect(employees.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(within(sidebar()).getByRole('button', { name: 'Hide Your team pages' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('never folds the group you are in', () => {
    mockPath = '/trust';
    render(<AppShell><div /></AppShell>);
    expect(within(sidebar()).getByRole('button', { name: 'Your team' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(sidebar()).getByRole('link', { name: 'Trust' })).toHaveAttribute('aria-current', 'page');
  });

  it('remembers which groups you opened', () => {
    const { unmount } = render(<AppShell><div /></AppShell>);
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'Oversight' }));
    unmount();
    expect(JSON.parse(window.localStorage.getItem(KEY) || '[]')).not.toContain('watch');
    render(<AppShell><div /></AppShell>);
    expect(within(sidebar()).getByRole('button', { name: 'Oversight' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('works when the browser will not store anything', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => render(<AppShell><div /></AppShell>)).not.toThrow();
    spy.mockRestore();
  });
});
