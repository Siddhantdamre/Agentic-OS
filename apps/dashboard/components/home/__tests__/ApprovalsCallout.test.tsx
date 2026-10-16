import React from 'react';
import { render, screen } from '@testing-library/react';
import { ApprovalsCallout } from '../ApprovalsCallout';

jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>;
  MockLink.displayName = 'MockLink';
  return MockLink;
});
let mockCount: number | null = 0;
jest.mock('@/lib/use-pending-approvals', () => ({ usePendingApprovalCount: () => mockCount }));

describe('ApprovalsCallout', () => {
  it('says how many approvals are waiting and takes you straight to them', () => {
    mockCount = 3;
    render(<ApprovalsCallout />);
    const link = screen.getByRole('link', { name: /Review/ });
    expect(link).toHaveAttribute('href', '/approvals');
    expect(screen.getByText('3 approvals are waiting for you')).toBeInTheDocument();
  });
  it('says it in the singular', () => {
    mockCount = 1;
    render(<ApprovalsCallout />);
    expect(screen.getByText('1 approval is waiting for you')).toBeInTheDocument();
  });
  it('shows nothing when nothing is waiting, or when the count is unknown', () => {
    mockCount = 0;
    const { container, rerender } = render(<ApprovalsCallout />);
    expect(container).toBeEmptyDOMElement();
    mockCount = null;
    rerender(<ApprovalsCallout />);
    expect(container).toBeEmptyDOMElement();
  });
});
