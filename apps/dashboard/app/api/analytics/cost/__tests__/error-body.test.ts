/**
 * @jest-environment node
 *
 * This route answers a tenant. When the cost backend is not configured it used to put the server's own
 * error text in the response: "LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY must be set in
 * production". That tells every customer which settings the platform uses and is meaningless to them. The
 * response now carries a fixed, customer-readable sentence; the detail goes to the server log.
 */
let mockFailure: Error = new Error('x');

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { release: jest.fn() }, orgId: 'org-1', userId: 'u-1' })),
  scopedAuthErrorResponse: () => null,
}));
jest.mock('@/lib/org-cost', () => {
  class LangfuseUnavailableError extends Error {}
  return {
    WEEK_DAYS: 7,
    LangfuseUnavailableError,
    queryConfirmRejectDrift: jest.fn(async () => null),
    fetchOrgWeeklyCost: jest.fn(async () => {
      throw mockFailure;
    }),
  };
});
jest.mock('@/lib/langfuse-trace', () => {
  class LangfuseConfigError extends Error {}
  return { LangfuseConfigError };
});

import { GET } from '../route';
import { LangfuseUnavailableError } from '@/lib/org-cost';
import { LangfuseConfigError } from '@/lib/langfuse-trace';

const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/;

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('GET /api/analytics/cost when the cost backend is unavailable', () => {
  it.each([
    ['not configured', () => new LangfuseConfigError('LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY must be set in production')],
    ['unreachable', () => new LangfuseUnavailableError('Langfuse request failed: connect ECONNREFUSED langfuse-server:3000 using LANGFUSE_SECRET_KEY')],
  ])('answers 503 with no configuration names in the body (%s)', async (_name, make) => {
    mockFailure = make();
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(ENV_NAME);
    expect(JSON.stringify(body)).not.toMatch(/langfuse-server|ECONNREFUSED/i);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(10);
  });

  it('still tells the caller the figures are unverified and what the source was', async () => {
    mockFailure = new LangfuseConfigError('LANGFUSE_HOST must be set');
    const body = await (await GET()).json();
    expect(body.verified).toBe(false);
    expect(body.source).toBe('langfuse');
  });

  it('keeps the real reason in the server log', async () => {
    mockFailure = new LangfuseConfigError('LANGFUSE_HOST must be set');
    await GET();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('/api/analytics/cost'), 'LANGFUSE_HOST must be set');
  });
});
