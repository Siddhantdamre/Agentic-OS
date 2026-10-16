import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ApprovalsPage from '../page';

jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>;
  MockLink.displayName = 'MockLink';
  return MockLink;
});
jest.mock('@/lib/use-live-refresh', () => ({ useLiveRefresh: jest.fn(() => ({ fallback: false })) }));

const emailRow = (id: string, to: string, body: string) => ({
  id, actionType: 'external_send', employeeRole: 'Customer Support', employeeName: 'Emma', status: 'pending',
  createdAt: new Date(Date.now() - 5 * 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
  requiredApprovals: 1, approvals: [],
  payload: { tool: 'gmail', action: 'send_email', reasonCode: 'confirm_class', summary: `Send email "About your enquiry" to ${to}`, payload: { to, subject: 'About your enquiry', body } },
});
const refundRow = {
  id: 'r1', actionType: 'pay', employeeRole: 'Finance', employeeName: 'Faye', status: 'pending',
  createdAt: new Date().toISOString(), expiresAt: null, requiredApprovals: 2, approvals: [{ userId: 'u9', at: 'x' }],
  payload: { tool: 'stripe', action: 'create_refund', reasonCode: 'confirm_class', summary: 'Refund 40.00 to customer', payload: { chargeId: 'ch_1', amount: 4000 } },
};

type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[];
let pending: unknown[];
let respond: (c: Call) => { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  pending = [emailRow('a1', 'priya@example.test', 'Hi Priya, the flat is free on Saturday.'), emailRow('a2', 'rahul@example.test', 'Hi Rahul, Green Park is 1.12 crore.'), refundRow];
  respond = (c) => (c.method === 'PATCH' ? { status: 200, body: { success: true, status: 'executed' } } : { status: 200, body: { decisions: pending } });
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = respond(c);
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
});

const cardOf = (text: string) => screen.getByText(text).closest('article') as HTMLElement;

describe('Approvals page', () => {
  it('shows each waiting action as a decision: who, what, the message itself, and why it was held', async () => {
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to priya@example.test');
    const card = cardOf('Send email "About your enquiry" to priya@example.test');
    expect(within(card).getByText('Emma')).toBeInTheDocument();
    expect(within(card).getByText('Hi Priya, the flat is free on Saturday.')).toBeInTheDocument();
    expect(within(card).getByText('Sending a message to a customer always needs your OK.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /3 waiting for you/i })).toBeInTheDocument();
  });

  it('approves one with one click and says what happened on the card', async () => {
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to priya@example.test');
    fireEvent.click(within(cardOf('Send email "About your enquiry" to priya@example.test')).getByRole('button', { name: 'Approve' }));
    await screen.findByText('Approved and sent.');
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([{ url: '/api/decisions', method: 'PATCH', body: { id: 'a1', status: 'approved' } }]);
  });

  it('can reject, and nothing is sent', async () => {
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to rahul@example.test');
    fireEvent.click(within(cardOf('Send email "About your enquiry" to rahul@example.test')).getByRole('button', { name: 'Reject' }));
    await screen.findByText('Rejected. Nothing was sent.');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ id: 'a2', status: 'rejected' });
  });

  it('lets a person fix a word before it goes out: edit, then approve sends the edited text', async () => {
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to priya@example.test');
    const card = cardOf('Send email "About your enquiry" to priya@example.test');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(card).getByLabelText('Message'), { target: { value: 'Hi Priya, Saturday at 11am works.' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve with changes' }));
    await screen.findByText('Approved and sent.');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      id: 'a1', status: 'approved',
      modifiedPayload: { to: 'priya@example.test', subject: 'About your enquiry', body: 'Hi Priya, Saturday at 11am works.' },
    });
  });

  it('approves several at once, but never a payment: money is read and approved one at a time', async () => {
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to priya@example.test');
    fireEvent.click(screen.getByRole('button', { name: /Select all 2 that are safe to approve together/i }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
    await waitFor(() => expect(screen.getAllByText('Approved and sent.')).toHaveLength(2));
    const decided = calls.filter((c) => c.method === 'PATCH').map((c) => (c.body as { id: string }).id);
    expect(decided.sort()).toEqual(['a1', 'a2']);
    expect(decided).not.toContain('r1');
    // The refund has no checkbox, and says why.
    expect(within(cardOf('Refund 40.00 to customer')).queryByRole('checkbox')).toBeNull();
    expect(within(cardOf('Refund 40.00 to customer')).getByText('1 of 2 approvals given')).toBeInTheDocument();
  });

  it('keyboard: A approves the highlighted one, R rejects it, J moves down', async () => {
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to priya@example.test');
    fireEvent.keyDown(document.body, { key: 'a' });
    await screen.findByText('Approved and sent.');
    fireEvent.keyDown(document.body, { key: 'j' });
    fireEvent.keyDown(document.body, { key: 'r' });
    await screen.findByText('Rejected. Nothing was sent.');
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ id: 'a1', status: 'approved' }, { id: 'a2', status: 'rejected' }]);
  });

  it('ignores the shortcut keys while typing in a box', async () => {
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to priya@example.test');
    fireEvent.click(within(cardOf('Send email "About your enquiry" to priya@example.test')).getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'a' });
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('tells the person when it did not run, in plain words, and keeps the card', async () => {
    respond = (c) => (c.method === 'PATCH' ? { status: 500, body: { success: false, status: 'execution_failed', error: 'The connection was refused. It did not run.' } } : { status: 200, body: { decisions: pending } });
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to priya@example.test');
    fireEvent.click(within(cardOf('Send email "About your enquiry" to priya@example.test')).getByRole('button', { name: 'Approve' }));
    await screen.findByText(/Approved, but it did not run: The connection was refused/);
  });

  it('says there is nothing waiting, and what will show up here', async () => {
    pending = [];
    render(<ApprovalsPage />);
    await screen.findByText('Nothing is waiting for you.');
    expect(screen.getByText(/send a message, move money or change something/i)).toBeInTheDocument();
  });

  it('says it could not load, rather than showing an empty list that reads as "nothing waiting"', async () => {
    respond = () => ({ status: 500, body: { error: 'Internal Server Error' } });
    render(<ApprovalsPage />);
    await screen.findByRole('alert');
    expect(screen.queryByText('Nothing is waiting for you.')).toBeNull();
  });

  it('shows what was decided before, with how each one ended', async () => {
    respond = (c) => (c.url.includes('history=1')
      ? { status: 200, body: { decisions: [{ ...emailRow('h1', 'anita@example.test', 'x'), status: 'executed', decidedAt: new Date().toISOString() }, { ...emailRow('h2', 'karan@example.test', 'y'), status: 'rejected', decidedAt: new Date().toISOString() }, { ...emailRow('h3', 'neha@example.test', 'z'), status: 'execution_failed', executionError: 'The action did not run.', decidedAt: new Date().toISOString() }] } }
      : { status: 200, body: { decisions: pending } });
    render(<ApprovalsPage />);
    await screen.findByText('Send email "About your enquiry" to priya@example.test');
    fireEvent.click(screen.getByRole('tab', { name: /Done/ }));
    await screen.findByText('Send email "About your enquiry" to anita@example.test');
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Did not run')).toBeInTheDocument();
  });
});
