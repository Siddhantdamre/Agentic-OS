/**
 * @jest-environment node
 *
 * The route-level promise of /api/trueforge/*: tenant identity comes from the session only, the caller's
 * credentials never leave this app, and the response is plain content.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
let scope: 'ok' | 'fails' = 'ok';
let upstream: { headers: Record<string, string>; body: string } = { headers: {}, body: '{}' };
const sent: Array<{ url: string; headers: Headers }> = [];

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => {
    if (scope === 'fails') throw new Error('no scope');
    return { client: { query: jest.fn(async () => ({ rows: [{ role: 'Support', name: 'Sam', tool_allowlist: [] }] })), release: jest.fn() }, orgId: ORG, userId: 'user-1' };
  }),
}));
jest.mock('@darex/workflows/dist/trueforge-client', () => ({
  buildMcpTenantHeaders: jest.fn(() => ({ 'x-darex-org-id': ORG, 'x-darex-signature': 'sig' })),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from '../route';

const call = (fn: typeof GET, path: string[], headers: Record<string, string> = {}, method = 'GET') =>
  fn(new NextRequest(`http://dash.test/api/trueforge/${path.join('/')}?x=1`, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) }), {
    params: Promise.resolve({ path }),
  });

const SPOOF = { 'x-org-id': '99999999-9999-4999-8999-999999999999', 'x-user-id': 'victim', 'x-tfg-mcp-headers': '{"darex":{"forged":true}}', cookie: 'darex_session=abc', authorization: 'Bearer abc' };

beforeEach(() => {
  scope = 'ok';
  sent.length = 0;
  upstream = { headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), headers: new Headers(init?.headers) });
    return new Response(upstream.body, { status: 200, headers: upstream.headers });
  }) as unknown as typeof fetch;
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('/api/trueforge proxy', () => {
  it('overwrites tenant identity with the session’s own, whatever the caller sent', async () => {
    await call(GET, ['v1', 'runs'], SPOOF);
    const h = sent[0].headers;
    expect(h.get('x-org-id')).toBe(ORG);
    expect(h.get('x-user-id')).toBe('user-1');
    expect(h.get('x-tfg-mcp-headers')).toContain('x-darex-signature');
    expect(h.get('x-tfg-mcp-headers')).not.toContain('forged');
  });

  it('forwards NO caller-written identity when the session scope cannot be established', async () => {
    scope = 'fails';
    await call(GET, ['v1', 'runs'], SPOOF);
    const h = sent[0].headers;
    expect(h.get('x-org-id')).toBeNull();
    expect(h.get('x-user-id')).toBeNull();
    expect(h.get('x-tfg-mcp-headers')).toBeNull();
  });

  it('does not forward the caller’s cookie or Authorization header', async () => {
    await call(GET, ['v1', 'runs'], SPOOF);
    expect(sent[0].headers.get('cookie')).toBeNull();
    expect(sent[0].headers.get('authorization')).toBeNull();
  });

  it('does not return an upstream Set-Cookie or a stale content-encoding', async () => {
    upstream = { headers: { 'content-type': 'application/json', 'set-cookie': 'tf=1; Path=/', 'content-encoding': 'gzip' }, body: '{"ok":true}' };
    const res = await call(GET, ['v1', 'runs']);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses a path that climbs out and never calls the upstream', async () => {
    const res = await call(GET, ['v1', '..', '..', 'admin']);
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('keeps the path and query it was given', async () => {
    await call(POST, ['v1', 'runs', 'abc'], {}, 'POST');
    expect(sent[0].url).toMatch(/\/v1\/runs\/abc\?x=1$/);
  });
});
