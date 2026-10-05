/**
 * @jest-environment node
 *
 * /api/trueforge/* signs requests on behalf of the signed-in tenant and forwards them to the agent service.
 * Three things must hold however the caller shapes the request:
 *  - tenant identity comes only from the session, never from a header the caller wrote;
 *  - the caller's credentials (session cookie, Authorization) are not handed to the upstream service;
 *  - what comes back is plain content: no upstream Set-Cookie, and no stale encoding or length headers
 *    (the fetch layer has already decoded the body, so a leftover `content-encoding: gzip` makes the browser
 *    try to decompress plain text).
 */
import { isSafeProxyPath, sanitizeForwardHeaders, sanitizeResponseHeaders } from '@/lib/trueforge-proxy-headers';

const h = (o: Record<string, string>) => new Headers(o);

describe('sanitizeForwardHeaders', () => {
  it('drops tenant-identity headers the caller supplied', () => {
    const out = sanitizeForwardHeaders(
      h({ 'x-org-id': '00000000-0000-4000-8000-000000000001', 'x-user-id': 'someone-else', 'x-tfg-mcp-headers': '{"darex":{}}', accept: 'application/json' })
    );
    expect(out.get('x-org-id')).toBeNull();
    expect(out.get('x-user-id')).toBeNull();
    expect(out.get('x-tfg-mcp-headers')).toBeNull();
    expect(out.get('accept')).toBe('application/json');
  });

  it("does not hand the caller's credentials to the upstream service", () => {
    const out = sanitizeForwardHeaders(h({ cookie: 'darex_session=abc.1.2.sig', authorization: 'Bearer secret', 'proxy-authorization': 'x' }));
    expect(out.get('cookie')).toBeNull();
    expect(out.get('authorization')).toBeNull();
    expect(out.get('proxy-authorization')).toBeNull();
  });

  it('drops hop-by-hop and framing headers', () => {
    const out = sanitizeForwardHeaders(h({ host: 'dash', connection: 'keep-alive', 'content-length': '12', 'transfer-encoding': 'chunked', upgrade: 'websocket', te: 'trailers', 'keep-alive': 'timeout=5' }));
    for (const k of ['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'keep-alive']) expect(out.get(k)).toBeNull();
  });

  it('keeps ordinary headers, including the content type and the employee selectors', () => {
    const out = sanitizeForwardHeaders(h({ 'content-type': 'application/json', 'x-employee-role': 'Support', 'user-agent': 'x' }));
    expect(out.get('content-type')).toBe('application/json');
    expect(out.get('x-employee-role')).toBe('Support');
    expect(out.get('user-agent')).toBe('x');
  });

  it('is case-insensitive about what it drops', () => {
    const out = sanitizeForwardHeaders(new Headers([['X-Org-Id', 'a'], ['Cookie', 'b'], ['AUTHORIZATION', 'c']]));
    expect([...out.keys()]).toEqual([]);
  });
});

describe('sanitizeResponseHeaders', () => {
  it('never passes an upstream Set-Cookie to the browser', () => {
    const out = sanitizeResponseHeaders(h({ 'set-cookie': 'tf_session=1; Path=/', 'content-type': 'application/json' }));
    expect(out.get('set-cookie')).toBeNull();
    expect(out.get('content-type')).toBe('application/json');
  });

  it('drops encoding and length headers that no longer describe the decoded body', () => {
    const out = sanitizeResponseHeaders(h({ 'content-encoding': 'gzip', 'content-length': '123', 'transfer-encoding': 'chunked', connection: 'keep-alive', 'keep-alive': 'timeout=5' }));
    for (const k of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']) expect(out.get(k)).toBeNull();
  });

  it('keeps streaming headers', () => {
    const out = sanitizeResponseHeaders(h({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }));
    expect(out.get('content-type')).toBe('text/event-stream');
    expect(out.get('cache-control')).toBe('no-cache');
  });
});

describe('isSafeProxyPath', () => {
  it('accepts ordinary paths', () => {
    expect(isSafeProxyPath([])).toBe(true);
    expect(isSafeProxyPath(['v1', 'runs', 'abc-123'])).toBe(true);
  });

  it.each([
    [['..', 'admin']],
    [['v1', '..', '..', 'x']],
    [['.']],
    [['a/../b']],
    [['a\\..\\b']],
    [['%2e%2e', 'x']],
    [['v1', 'x\u0000y']],
    [['v1', 'a b\nc']],
  ])('refuses %j', (segments) => {
    expect(isSafeProxyPath(segments)).toBe(false);
  });
});
