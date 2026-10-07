import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GetStarted } from '../GetStarted';

jest.mock('next/link', () => {
  const MockLink = ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>;
  MockLink.displayName = 'MockLink';
  return MockLink;
});

type Replies = { brain?: unknown; chats?: unknown; brainFails?: boolean; chatsFails?: boolean };
function reply({ brain = { empty: true }, chats = { conversations: [] }, brainFails, chatsFails }: Replies) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.startsWith('/api/brain')) {
      if (brainFails) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => brain } as Response;
    }
    if (u.startsWith('/api/ask-ai/conversations')) {
      if (chatsFails) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return { ok: true, json: async () => chats } as Response;
    }
    throw new Error('unexpected ' + u);
  }) as unknown as typeof fetch;
}

beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });

describe('Get started', () => {
  it('lists the three first steps of a new workspace, each with a link to do it', async () => {
    reply({});
    render(<GetStarted channelCount={0} />);
    expect(await screen.findByText('Get started')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect your first app/ })).toHaveAttribute('href', '/connectors');
    expect(screen.getByRole('link', { name: /Teach it your business/ })).toHaveAttribute('href', '/brain');
    expect(screen.getByRole('link', { name: /Ask your first question/ })).toHaveAttribute('href', '/ask-ai');
    expect(screen.getByText('0 of 3 done')).toBeInTheDocument();
  });

  it('ticks off what is already done and counts it', async () => {
    reply({ brain: { empty: false }, chats: { conversations: [{ id: 'a', message_count: 0 }] } });
    render(<GetStarted channelCount={1} />);
    expect(await screen.findByText('2 of 3 done')).toBeInTheDocument();
  });

  it('is gone once everything is done, so a working account sees no onboarding', async () => {
    reply({ brain: { empty: false }, chats: { conversations: [{ id: 'a', message_count: 4 }] } });
    const { container } = render(<GetStarted channelCount={2} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('does not count an empty chat as a question asked', async () => {
    reply({ chats: { conversations: [{ id: 'a', message_count: 0 }] } });
    render(<GetStarted channelCount={1} />);
    expect(await screen.findByText('1 of 3 done')).toBeInTheDocument();
  });

  it('shows nothing rather than a wrong tick when a lookup fails', async () => {
    reply({ brainFails: true });
    const { container } = render(<GetStarted channelCount={0} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
    reply({ chatsFails: true });
    const second = render(<GetStarted channelCount={0} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });

  it('can be hidden, and stays hidden', async () => {
    reply({});
    const { unmount } = render(<GetStarted channelCount={0} />);
    fireEvent.click(await screen.findByRole('button', { name: /Hide/ }));
    expect(screen.queryByText('Get started')).not.toBeInTheDocument();
    unmount();
    reply({});
    const again = render(<GetStarted channelCount={0} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(again.container).toBeEmptyDOMElement();
  });

  it('waits for the channel count instead of guessing', () => {
    reply({});
    const { container } = render(<GetStarted channelCount={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
