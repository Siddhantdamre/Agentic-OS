import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

jest.mock('@/lib/use-live-refresh', () => ({ useLiveRefresh: () => undefined }));

import ObservabilityPage from '../page';

/**
 * "Employee health" is where an owner checks that their AI employees are behaving. Two things must hold:
 *  - when it cannot load, it says so — it must never read "0 metrics outside the healthy band" because
 *    the request failed (that would look like good news);
 *  - a dropped connection must never surface as an unhandled promise rejection or a parser error.
 */
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number) => ({ ok: false, status, json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')) });

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  jest.restoreAllMocks();
});

const settle = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};

describe('observability page', () => {
  it('says it could not load, and does not claim a clean bill of health, when the network is down', async () => {
    global.fetch = jest.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    render(<ObservabilityPage />);
    await settle();
    expect(screen.getByText(/couldn.?t load/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 metrics outside the healthy band/i)).not.toBeInTheDocument();
    expect(unhandled).toEqual([]);
  });

  it('says it could not load when the metrics request fails with a server error', async () => {
    global.fetch = jest.fn(async (url: string) => (String(url).includes('/metrics') ? fail(500) : ok({}))) as unknown as typeof fetch;
    render(<ObservabilityPage />);
    await settle();
    expect(screen.getByText(/couldn.?t load/i)).toBeInTheDocument();
    expect(unhandled).toEqual([]);
  });

  it('shows the real numbers, and no warning, when everything loads', async () => {
    global.fetch = jest.fn(async (url: string) =>
      ok(String(url).includes('/metrics') ? { metrics: [], alertCount: 2, rolloutStage: 1, killSwitch: false } : {})
    ) as unknown as typeof fetch;
    render(<ObservabilityPage />);
    await screen.findByText(/2 metrics outside the healthy band/i);
    expect(screen.queryByText(/couldn.?t load/i)).not.toBeInTheDocument();
  });

  it('shows a plain sentence when the backfill fails with an empty body', async () => {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/backfill') && init?.method === 'POST') return fail(500);
      return ok(String(url).includes('/metrics') ? { metrics: [], alertCount: 0, rolloutStage: 0, killSwitch: false } : {});
    }) as unknown as typeof fetch;
    render(<ObservabilityPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /backfill/i }));
    const note = await screen.findByText(/couldn.?t|try again/i);
    expect(note.textContent).not.toMatch(/JSON|Unexpected|undefined/i);
    expect(unhandled).toEqual([]);
  });

  it('survives a dropped connection while explaining a decision', async () => {
    global.fetch = jest.fn(async (url: string) => {
      if (String(url).includes('/agent/explain')) throw new TypeError('Failed to fetch');
      return ok(String(url).includes('/metrics') ? { metrics: [], alertCount: 0, rolloutStage: 0, killSwitch: false } : {});
    }) as unknown as typeof fetch;
    render(<ObservabilityPage />);
    await settle();
    fireEvent.change(screen.getByPlaceholderText(/why didn/i), { target: { value: 'anything' } });
    fireEvent.click(screen.getByRole('button', { name: /explain/i }));
    await waitFor(() => expect(screen.getByText(/couldn.?t|try again/i)).toBeInTheDocument());
    expect(unhandled).toEqual([]);
  });
});
