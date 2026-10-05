import React from 'react';
import { render, screen, act } from '@testing-library/react';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => ({ get: () => null }),
  usePathname: () => '/',
}));
jest.mock('@/lib/nango-client', () => ({ startRealNangoOAuth: jest.fn(), disconnectProvider: jest.fn() }));
jest.mock('@/lib/use-live-refresh', () => ({ useLiveRefresh: () => undefined }));
jest.mock('@/lib/use-realtime-stream', () => ({ useRealtimeStream: () => ({ fallback: false }) }));

import InsightPage from '../insight/page';
import PlansPage from '../plans/page';
import SkillsPage from '../skills/page';
import BrainPage from '../brain/page';
import BillingPage from '../billing/page';

/**
 * A page whose data cannot be loaded must say so. Showing an empty list ("no plans", "no insights", every tool
 * "not connected") because the request failed is worse than an error: the person believes it, and acts on it.
 */
const unhandled: unknown[] = [];
const onUnhandled = (r: unknown) => unhandled.push(r);

type Mode = { name: string; respond: () => Promise<unknown> };
const MODES: Mode[] = [
  { name: 'server error with an empty body', respond: async () => ({ ok: false, status: 500, json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')) }) },
  { name: 'rate limited', respond: async () => ({ ok: false, status: 429, json: async () => ({ error: 'Too many requests' }) }) },
  { name: 'dropped connection', respond: () => Promise.reject(new TypeError('Failed to fetch')) },
];

const PAGES: Array<[string, React.ComponentType]> = [
  ['insight', InsightPage],
  ['plans', PlansPage],
  ['skills', SkillsPage],
  ['brain', BrainPage],
  ['billing', BillingPage],
];

// What a person may read. Anything that looks like the browser's or the server's own wording is a failure.
const PLAIN = /couldn.?t|could not|try again|unavailable|not able|didn.?t load|wait a moment/i;
const RAW = /Failed to fetch|Unexpected end|SyntaxError|TypeError|undefined|Too many requests|\(\s*(?:429|500)\s*\)/;

beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  jest.restoreAllMocks();
});

describe.each(PAGES)('%s page', (_name, Page) => {
  it.each(MODES)('says so in plain words on a $name, and never shows raw error text', async (mode) => {
    global.fetch = jest.fn(() => mode.respond()) as unknown as typeof fetch;
    const { container } = render(<Page />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    const text = container.textContent || '';
    expect(text).toMatch(PLAIN);
    expect(text).not.toMatch(RAW);
    expect(unhandled).toEqual([]);
  });
});
