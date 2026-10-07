import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/conversations',
}));
jest.mock('@/lib/nango-client', () => ({ startRealNangoOAuth: jest.fn(), disconnectProvider: jest.fn() }));
jest.mock('@/lib/use-realtime-stream', () => ({ useRealtimeStream: () => ({ fallback: false }) }));

import ConversationsPage from '../page';

const convo = (over: Record<string, unknown> = {}) => ({
  id: 'c1', org_id: 'o1', chatwoot_conv_id: 1, status: 'open', contact_id: 'ask-ai:97fdee74-209e-4942-b3e3-edb8399840c7',
  summary: 'Ask AI', metadata: {}, started_at: '2026-10-07T01:00:00Z', updated_at: '2026-10-07T01:07:00Z',
  employee_id: 'e1', employee_name: 'Sarah', employee_role: 'Sales Representative', channel_type: 'ask-ai',
  last_message: 'hello', last_message_at: '2026-10-07T01:07:00Z', message_count: 2, ...over,
});

function serve(list: unknown[]) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.startsWith('/api/conversations?')) return { ok: true, status: 200, json: async () => ({ conversations: list }) } as Response;
    if (u.includes('/messages')) return { ok: true, status: 200, json: async () => ({ messages: [] }) } as Response;
    if (u.startsWith('/api/employees')) return { ok: true, status: 200, json: async () => ({ employees: [] }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

describe('Inbox, as a person reads it', () => {
  it('shows a plain name for an Ask AI chat, not the internal id', async () => {
    serve([convo()]);
    render(<ConversationsPage />);
    await screen.findAllByText('Ask AI chat');
    expect(screen.queryByText(/ask-ai:97fdee74/)).not.toBeInTheDocument();
  });

  it('keeps a customer’s phone number beside their name in the open conversation', async () => {
    serve([convo({ id: 'c2', contact_id: '+919800000000', channel_type: 'whatsapp', metadata: { sender_name: 'Priya Nair' } })]);
    render(<ConversationsPage />);
    fireEvent.click((await screen.findAllByText('Priya Nair'))[0]);
    expect((await screen.findAllByText('+919800000000')).length).toBeGreaterThan(0);
  });

  it('puts the filters in a drawer you open, so the conversation keeps its room', async () => {
    serve([convo()]);
    render(<ConversationsPage />);
    const open = await screen.findByRole('button', { name: /Filters/ });
    const drawer = document.getElementById('inbox-filters')!;
    expect(drawer.className).toMatch(/(^|\s)hidden(\s|$)/);
    fireEvent.click(open);
    expect(drawer.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close filters' }));
    expect(drawer.className).toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('says "Reply to customer" and "Private note", and keeps the practice mode out of the way', async () => {
    serve([convo()]);
    render(<ConversationsPage />);
    fireEvent.click((await screen.findAllByText('Ask AI chat'))[0]);
    expect(await screen.findByRole('button', { name: 'Reply to customer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Private note' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/Simulate Customer/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Practise as the customer' }));
    expect(screen.getByPlaceholderText(/Type as the customer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Private note' }));
    expect(screen.getByPlaceholderText(/Internal note/)).toBeInTheDocument();
  });

  it('reads at a width where the old layout left the conversation 112 px wide: the context column is wide-screen only', async () => {
    serve([convo()]);
    render(<ConversationsPage />);
    fireEvent.click((await screen.findAllByText('Ask AI chat'))[0]);
    await waitFor(() => expect(screen.getByText('Customer Context')).toBeInTheDocument());
    const panel = screen.getByText('Customer Context').closest('div.hidden')!;
    expect(panel.className).toMatch(/2xl:block/);
    expect(panel.className).not.toMatch(/lg:block/);
  });

  it('lets the conversation header controls wrap instead of running off a phone screen', async () => {
    serve([convo()]);
    render(<ConversationsPage />);
    fireEvent.click((await screen.findAllByText('Ask AI chat'))[0]);
    const status = await screen.findByLabelText('Conversation Status');
    expect(status.parentElement!.className).toMatch(/flex-wrap/);
  });
});
