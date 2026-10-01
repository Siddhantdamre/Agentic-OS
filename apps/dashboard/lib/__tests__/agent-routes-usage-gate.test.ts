/**
 * @jest-environment node
 *
 * Hard usage cap (billing) must stop direct agent run/stream/crew LLM turns
 * with a 402 and a clear code, before any employee/model work starts.
 */
import { POST as run } from '@/app/api/agent/run/route';
import { POST as stream } from '@/app/api/agent/stream/route';
import { POST as crew } from '@/app/api/agent/crew/route';

const release = jest.fn();
const query = jest.fn();

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({
    orgId: '00000000-0000-4000-8000-000000000001',
    userId: 'u1',
    client: { query: (...a: unknown[]) => query(...a), release: () => release() },
  })),
  scopedAuthErrorResponse: jest.fn(() => null),
}));

const mockAssert = jest.fn();
jest.mock('@darex/workflows/dist/usage-gate', () => ({
  USAGE_BLOCKED_CODE: 'USAGE_CAP_REACHED',
  USAGE_BLOCKED_MESSAGE: 'Hard usage cap reached',
  assertUsageAllowed: (...a: unknown[]) => mockAssert(...a),
  isUsageBlocked: jest.fn(),
}));
jest.mock('@/app/api/billing/_lib', () => ({ refreshOrgMeters: jest.fn() }));
jest.mock('@darex/workflows/dist/agent-client', () => ({}));
jest.mock('@darex/workflows/dist/memory/employee-retrieve', () => ({}));
jest.mock('@darex/workflows/dist/workflow-client', () => ({}));
jest.mock('@darex/workflows/dist/tool-executor', () => ({}));
jest.mock('@/lib/langfuse-trace', () => ({ logLangfuseTrace: jest.fn() }));

function req() {
  return new Request('http://t/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userMessage: 'hi' }),
  });
}

describe('agent routes usage gate', () => {
  beforeEach(() => {
    release.mockClear();
    query.mockClear();
    mockAssert.mockResolvedValue({
      error: 'USAGE_CAP_REACHED',
      message: 'Hard usage cap reached',
      gate: { blocked: true, orgId: 'o', reasons: [{ kind: 'llm_tokens' }], refreshed: false },
    });
  });

  it.each([
    ['run', run],
    ['stream', stream],
    ['crew', crew],
  ])('%s returns 402 USAGE_CAP_REACHED and does no DB work', async (_n, handler) => {
    const res = await handler(req());
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe('USAGE_CAP_REACHED');
    expect(release).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});
