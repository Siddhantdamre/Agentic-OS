import { requestIdFor, REQUEST_ID_HEADER } from '../request-id';

/** Every response carries an id a customer can quote to support and a log line can be searched by. */
describe('request id', () => {
  it('makes a fresh id when the request has none', () => {
    const a = requestIdFor(null);
    const b = requestIdFor(undefined);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);
  });

  it('keeps a sensible id sent by a proxy so one request has one id end to end', () => {
    expect(requestIdFor('abc-123_DEF')).toBe('abc-123_DEF');
  });

  it('replaces anything long, empty or with odd characters (it ends up in logs and headers)', () => {
    for (const bad of ['', 'a'.repeat(65), 'has space', 'new\nline', '<script>', 'ünï']) {
      const id = requestIdFor(bad);
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('uses the conventional header name', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });
});
