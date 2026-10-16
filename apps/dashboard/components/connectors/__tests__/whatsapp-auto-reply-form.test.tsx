import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WhatsAppAutoReplyForm from '../whatsapp-auto-reply-form';

const DEFAULTS = {
  mode: 'agent',
  instructions: '',
  message: '',
  cooldownMinutes: 720,
  fallbackTemplate: null,
  audience: 'everyone',
  numbers: [],
  replyTo: 'every_message',
  employeeId: null,
  hours: { mode: 'always', timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  readMedia: true,
  humanPauseHours: 2,
  holdingReply: { enabled: false, message: 'Thanks for your message. A teammate is checking and will reply shortly.' },
};

const EMPLOYEES = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Sarah', role: 'Customer Support' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Raj', role: 'Sales' },
];

let puts: any[] = [];

function mockApi(putResponse: { ok: boolean; body: unknown } = { ok: true, body: { success: true } }, provider = 'meta-cloud') {
  puts = [];
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      return Promise.resolve({ ok: putResponse.ok, status: putResponse.ok ? 200 : 400, json: async () => putResponse.body } as Response);
    }
    return Promise.resolve({ ok: true, json: async () => ({ settings: DEFAULTS, provider, employees: EMPLOYEES }) } as Response);
  }) as unknown as typeof fetch;
}

async function open(onSaved = jest.fn(), onSkip = jest.fn()) {
  render(<WhatsAppAutoReplyForm onSaved={onSaved} onSkip={onSkip} />);
  await screen.findByTestId('auto-reply-summary');
  return { onSaved, onSkip };
}

describe('WhatsAppAutoReplyForm', () => {
  it('says in one sentence what will happen', async () => {
    mockApi();
    await open();
    expect(screen.getByTestId('auto-reply-summary')).toHaveTextContent(
      'Your AI employee will reply to everyone, on every message.'
    );
  });

  it('allow list: shows the numbers box, counts them in the summary, sends them on save', async () => {
    mockApi();
    const { onSaved } = await open();
    fireEvent.change(screen.getByLabelText('Reply to'), { target: { value: 'allow_list' } });
    fireEvent.change(screen.getByLabelText(/Allowed numbers/), { target: { value: '919812345678\n14155552671' } });
    expect(screen.getByTestId('auto-reply-summary')).toHaveTextContent('only the 2 numbers on your allow list');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts[0]).toMatchObject({ mode: 'agent', audience: 'allow_list', numbers: '919812345678\n14155552671' });
  });

  it('new conversations only is reflected in the summary', async () => {
    mockApi();
    await open();
    fireEvent.change(screen.getByLabelText('Reply on'), { target: { value: 'new_conversations' } });
    expect(screen.getByTestId('auto-reply-summary')).toHaveTextContent('the first message of each new conversation');
  });

  it('instructions box appears for the AI modes and is sent; off hides who/when', async () => {
    mockApi();
    await open();
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Never promise discounts.' } });
    fireEvent.click(screen.getByLabelText(/Simple AI reply/));
    expect(screen.getByLabelText('Instructions')).toHaveValue('Never promise discounts.');
    fireEvent.click(screen.getByLabelText(/^Off/));
    expect(screen.queryByLabelText('Reply to')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Instructions')).not.toBeInTheDocument();
    expect(screen.getByTestId('auto-reply-summary')).toHaveTextContent('No automatic replies');
  });

  it('shows the server’s reason when saving fails and does not close', async () => {
    mockApi({ ok: false, body: { success: false, message: 'Add at least one number, or nobody will get a reply' } });
    const { onSaved } = await open();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/Add at least one number/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('the 24-hour template box is for the official API only', async () => {
    mockApi(undefined, 'evolution');
    await open();
    expect(screen.queryByText(/After 24 hours of silence/)).not.toBeInTheDocument();
  });

  it('lets the owner pick which AI employee answers and names them in the summary', async () => {
    mockApi();
    const { onSaved } = await open();
    const select = screen.getByLabelText('AI employee');
    expect(select).toHaveValue('');
    fireEvent.change(select, { target: { value: '22222222-2222-4222-8222-222222222222' } });
    expect(screen.getByTestId('auto-reply-summary')).toHaveTextContent('Raj (your AI employee) will reply');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts[0]).toMatchObject({ employeeId: '22222222-2222-4222-8222-222222222222' });
  });

  it('the employee picker is only for agent mode', async () => {
    mockApi();
    await open();
    fireEvent.click(screen.getByLabelText(/Simple AI reply/));
    expect(screen.queryByLabelText('AI employee')).not.toBeInTheDocument();
  });

  it('business hours: options appear, the summary states them, and they are saved', async () => {
    mockApi();
    const { onSaved } = await open();
    expect(screen.queryByLabelText('Opens')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: 'outside_hours' } });
    fireEvent.change(screen.getByLabelText('Opens'), { target: { value: '10:00' } });
    fireEvent.click(screen.getByLabelText('Sat'));
    expect(screen.getByTestId('auto-reply-summary')).toHaveTextContent('only when closed (Mon, Tue, Wed, Thu, Fri, Sat 10:00-18:00 UTC)');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts[0].hours).toEqual({ mode: 'outside_hours', timezone: 'UTC', days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '18:00' });
  });

  it('human takeover pause and media reading are options', async () => {
    mockApi();
    const { onSaved } = await open();
    fireEvent.change(screen.getByLabelText(/keep the AI quiet for/), { target: { value: '0' } });
    fireEvent.click(screen.getByLabelText(/Read voice notes and images/));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts[0]).toMatchObject({ humanPauseHours: 0, readMedia: false });
  });

  it('the media option is hidden for the fixed message', async () => {
    mockApi();
    await open();
    fireEvent.click(screen.getByLabelText(/^Fixed message/));
    expect(screen.queryByLabelText(/Read voice notes and images/)).not.toBeInTheDocument();
  });

  it('waiting message option: off until ticked, then editable and saved', async () => {
    mockApi();
    const { onSaved } = await open();
    expect(screen.queryByLabelText('Waiting message')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Tell the customer to wait/));
    fireEvent.change(screen.getByLabelText('Waiting message'), { target: { value: 'One moment please.' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts[0].holdingReply).toEqual({ enabled: true, message: 'One moment please.' });
  });

  it('reads and saves the settings of the number it was opened for', async () => {
    mockApi();
    render(<WhatsAppAutoReplyForm onSaved={jest.fn()} onSkip={jest.fn()} channelId="33333333-3333-4333-8333-333333333333" />);
    await screen.findByTestId('auto-reply-summary');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => String(u));
    expect(urls.every((u) => u.endsWith('?channelId=33333333-3333-4333-8333-333333333333'))).toBe(true);
    expect(urls).toHaveLength(2);
  });

  it('does not say "0 numbers" while the allow list is still empty', async () => {
    mockApi();
    await open();
    fireEvent.change(screen.getByLabelText('Reply to'), { target: { value: 'allow_list' } });
    const text = screen.getByTestId('auto-reply-summary').textContent || '';
    expect(text).toContain('nobody yet');
    expect(text).not.toContain('0 numbers');
  });
});
