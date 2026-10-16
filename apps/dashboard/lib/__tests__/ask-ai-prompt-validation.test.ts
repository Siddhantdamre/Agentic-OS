/**
 * @jest-environment node
 *
 * A blank prompt must be rejected before any conversation, plan or agent work runs.
 */

import { POST } from '@/app/api/ask-ai/route';

const queries: string[] = [];

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({
    client: {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }),
      release: jest.fn(),
    },
    orgId: '00000000-0000-4000-8000-000000000001',
    userId: 'user-blank-prompt',
  })),
  scopedAuthErrorResponse: jest.fn(() => null),
  releaseScopedClient: jest.fn(async () => {}),
  getOrgScopedClient: jest.fn(),
}));

jest.mock('@/lib/usage-gate', () => ({
  assertUsageAllowed: jest.fn(async () => null),
}));

jest.mock('@/lib/rate-limit', () => ({
  denyAskAiIfLimitedAsync: jest.fn(() => null),
  denyAskAiBusy: jest.fn(() => null),
  tryAcquireConcurrency: jest.fn(() => ({ allowed: true, release: jest.fn() })),
  isRateLimitError: jest.fn(() => false),
  responseFromRateLimit: jest.fn(),
}));

function post(prompt: unknown): Promise<Response> {
  return POST(
    new Request('https://app.darex.test/api/ask-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
  );
}

describe('POST /api/ask-ai prompt validation', () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it.each([['   '], ['\n\t '], [''], [undefined], [42]])('rejects %j with 400 and never reaches conversation work', async (prompt) => {
    const res = await post(prompt);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Prompt is required' });
    expect(queries.some((q) => /INSERT INTO (messages|conversations)/i.test(q))).toBe(false);
  });
});
