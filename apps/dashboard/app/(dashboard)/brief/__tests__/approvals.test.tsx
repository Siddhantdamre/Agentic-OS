import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>;
  MockLink.displayName = 'MockLink';
  return MockLink;
});
jest.mock('@/lib/use-live-refresh', () => ({ useLiveRefresh: () => undefined }));
jest.mock('@/components/explain/ExplainDrawer', () => ({ ExplainDrawer: () => null }));
let mockWaiting: number | null = 0;
jest.mock('@/lib/use-pending-approvals', () => ({ usePendingApprovalCount: () => mockWaiting }));

import BriefPage from '../page';

// "Nothing needs you" while three emails wait for approval is the one thing this page must never say.
beforeEach(() => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ exceptions: [], handledOvernight: 4 }) }) as Response) as unknown as typeof fetch;
});

describe('Morning brief and approvals', () => {
  it('does not say nothing needs you while approvals are waiting', async () => {
    mockWaiting = 3;
    render(<BriefPage />);
    expect(await screen.findByText('3 approvals are waiting for you')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs you.')).toBeNull();
  });

  it('says nothing needs you only when that is true', async () => {
    mockWaiting = 0;
    render(<BriefPage />);
    expect(await screen.findByText('Nothing needs you.')).toBeInTheDocument();
  });
});
