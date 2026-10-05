import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const push = jest.fn();
let searchToken: string | null = 'tok123';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => ({ get: (k: string) => (k === 'token' ? searchToken : null) }),
  useParams: () => ({ token: 'invite-abc' }),
}));

import ForgotPasswordPage from '../forgot-password/page';
import ResetPasswordPage from '../reset-password/page';
import InviteAcceptPage from '../invite/[token]/page';

/**
 * The recovery and invite pages are what someone meets when they are already stuck — locked out, or joining a
 * team for the first time. When the connection drops they must say so and let the person try again:
 * never a spinner that never ends, a button that stays greyed out, or a raw parser error.
 */
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

const res = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: body === undefined ? () => Promise.reject(new SyntaxError('Unexpected end of JSON input')) : async () => body,
});
const down = () => Promise.reject(new TypeError('Failed to fetch'));
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  push.mockReset();
  searchToken = 'tok123';
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  jest.restoreAllMocks();
});

describe('forgot password', () => {
  const submit = () => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button'));
  };

  it('tells the person when the connection drops, and lets them try again', async () => {
    global.fetch = jest.fn(down) as unknown as typeof fetch;
    render(<ForgotPasswordPage />);
    submit();
    expect(await screen.findByText(/couldn.?t|try again/i)).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeEnabled();
    expect(screen.queryByText(/we sent a reset link/i)).not.toBeInTheDocument();
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('does not claim an email was sent when the server is rate limiting or failing', async () => {
    for (const status of [429, 500]) {
      global.fetch = jest.fn(async () => res(status)) as unknown as typeof fetch;
      const { unmount } = render(<ForgotPasswordPage />);
      submit();
      expect(await screen.findByText(/couldn.?t|try again|too fast|moment/i)).toBeInTheDocument();
      expect(screen.queryByText(/we sent a reset link/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('gives the same reassuring answer whether or not the account exists', async () => {
    global.fetch = jest.fn(async () => res(200, { status: 'OK' })) as unknown as typeof fetch;
    render(<ForgotPasswordPage />);
    submit();
    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument();
  });
});

describe('reset password', () => {
  const fill = () => {
    const [a, b] = Array.from(document.querySelectorAll('input[type="password"]'));
    fireEvent.change(a, { target: { value: 'a-long-password' } });
    fireEvent.change(b, { target: { value: 'a-long-password' } });
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
  };

  it('tells the person when the connection drops, and re-enables the button', async () => {
    global.fetch = jest.fn(down) as unknown as typeof fetch;
    render(<ResetPasswordPage />);
    fill();
    expect(await screen.findByText(/couldn.?t|try again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update password/i })).toBeEnabled();
    await settle();
    expect(unhandled).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it('shows a plain sentence, not a parser error, on an empty failure', async () => {
    global.fetch = jest.fn(async () => res(500)) as unknown as typeof fetch;
    render(<ResetPasswordPage />);
    fill();
    const msg = await screen.findByText(/couldn.?t|try again|wrong/i);
    expect(msg.textContent).not.toMatch(/JSON|Unexpected|undefined/i);
  });

  it('shows the server’s own sentence when it sends one', async () => {
    global.fetch = jest.fn(async () => res(400, { message: 'This reset link has expired.' })) as unknown as typeof fetch;
    render(<ResetPasswordPage />);
    fill();
    expect(await screen.findByText(/reset link has expired/i)).toBeInTheDocument();
  });

  it('sends the person to sign in after a successful reset', async () => {
    global.fetch = jest.fn(async () => res(200, { status: 'OK' })) as unknown as typeof fetch;
    render(<ResetPasswordPage />);
    fill();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
  });
});

describe('invite', () => {
  it('stops spinning and says so when the invite cannot be loaded', async () => {
    global.fetch = jest.fn(down) as unknown as typeof fetch;
    render(<InviteAcceptPage />);
    expect(await screen.findByText(/couldn.?t|try again/i)).toBeInTheDocument();
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('keeps the Accept button available after a failed attempt so the person can retry', async () => {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/auth/session')) return res(200, { authenticated: true });
      if (init?.method === 'POST') throw new TypeError('Failed to fetch');
      return res(200, { orgName: 'Acme Homes', email: 'a@b.co' });
    }) as unknown as typeof fetch;
    render(<InviteAcceptPage />);
    fireEvent.click(await screen.findByRole('button', { name: /accept invite/i }));
    expect(await screen.findByText(/couldn.?t|try again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept invite/i })).toBeEnabled();
    await settle();
    expect(unhandled).toEqual([]);
  });

  it('takes the person to the dashboard once the invite is accepted', async () => {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/api/auth/session')) return res(200, { authenticated: true });
      if (init?.method === 'POST') return res(200, { ok: true });
      return res(200, { orgName: 'Acme Homes', email: 'a@b.co' });
    }) as unknown as typeof fetch;
    render(<InviteAcceptPage />);
    fireEvent.click(await screen.findByRole('button', { name: /accept invite/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });
});
