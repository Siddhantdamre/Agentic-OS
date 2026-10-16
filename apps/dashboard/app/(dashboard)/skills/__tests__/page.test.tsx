import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SkillsPage from '../page';

// Mock Next.js Link
jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  );
  MockLink.displayName = 'MockLink';
  return MockLink;
});

describe('SkillsPage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = jest.fn((url: RequestInfo | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/api/integrations')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            integrations: [
              { id: 'google-calendar', connected: true, status: 'connected' },
              { id: 'gmail', connected: true, status: 'connected' },
              { id: 'shopify', connected: false, status: 'disconnected' },
            ],
          }),
        } as Response);
      }
      if (u.includes('/api/employees')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            employees: [
              {
                id: 'emp-1',
                name: 'Ava',
                role: 'operations',
                tool_allowlist: ['google-calendar', 'gmail'],
                status: 'active',
              },
            ],
          }),
        } as Response);
      }
      return Promise.reject(new Error(`Unhandled fetch url: ${u}`));
    });
  });

  it('renders playbook skills title and subtitle', async () => {
    render(<SkillsPage />);
    expect(screen.getByText('Playbook Skills')).toBeInTheDocument();
    expect(screen.getByText('Built in')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    });
  });

  it('displays ready badge for connected skills and needs connector for disconnected skills', async () => {
    render(<SkillsPage />);
    await waitFor(() => {
      expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    });

    const readyBadges = screen.getAllByText('Ready');
    expect(readyBadges.length).toBeGreaterThanOrEqual(1);

    const needsConnectorBadges = screen.getAllByText('Needs Connector');
    expect(needsConnectorBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('displays assigned AI employees mapped to connector tools', async () => {
    render(<SkillsPage />);
    await waitFor(() => {
      const badges = screen.getAllByText('@Ava (operations)');
      expect(badges.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('filters playbooks by search query', async () => {
    render(<SkillsPage />);
    await waitFor(() => {
      expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search playbooks/i);
    fireEvent.change(searchInput, { target: { value: 'Shopify' } });

    expect(screen.getByText('E-commerce (Shopify)')).toBeInTheDocument();
    expect(screen.queryByText('Google Calendar')).not.toBeInTheDocument();
  });

  it('filters playbooks using ready/needs setup tabs', async () => {
    render(<SkillsPage />);
    await waitFor(() => {
      expect(screen.getByText('Google Calendar')).toBeInTheDocument();
    });

    // Click "Needs Setup" tab
    const needsSetupTab = screen.getByText(/Needs Setup/i);
    fireEvent.click(needsSetupTab);

    // Shopify should be in Needs Setup
    expect(screen.getByText('E-commerce (Shopify)')).toBeInTheDocument();
    // Google Calendar should not be shown
    expect(screen.queryByText('Google Calendar')).not.toBeInTheDocument();
  });
});
