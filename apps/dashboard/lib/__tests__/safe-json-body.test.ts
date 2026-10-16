/**
 * @jest-environment node
 *
 * A request body is attacker-controlled. `null` is valid JSON, so `await request.json().catch(() => ({}))`
 * hands `null` to the destructuring that follows and the route answers 500. A NUL character
 * (\u0000) is valid JSON but Postgres rejects it in text and jsonb, so it becomes a 500 one layer down.
 * jsonBodyOrEmpty turns every one of those into an ordinary empty/clean object, so the route's own
 * validation answers with a 400.
 */
import { jsonBodyOrEmpty, readJsonBody, stripNulChars, tryReadJson } from '@/lib/safe-json';

const req = (body: string | undefined, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Request('http://x/api/y', { method: 'POST', headers, body });

describe('jsonBodyOrEmpty', () => {
  it('returns a normal object untouched', async () => {
    expect(await jsonBodyOrEmpty(req('{"a":1,"b":{"c":"d"}}'))).toEqual({ a: 1, b: { c: 'd' } });
  });

  it.each([
    ['the literal null', 'null'],
    ['invalid JSON', '{"a":'],
    ['an empty body', ''],
    ['a bare number', '5'],
    ['a bare string', '"x"'],
    ['true', 'true'],
    ['an array', '[1,2]'],
  ])('returns {} for %s', async (_name, raw) => {
    expect(await jsonBodyOrEmpty(req(raw))).toEqual({});
  });

  it('returns {} when there is no body at all', async () => {
    expect(await jsonBodyOrEmpty(new Request('http://x/api/y', { method: 'POST' }))).toEqual({});
  });

  it('strips NUL characters from every string, however deep (Postgres rejects them)', async () => {
    const out = await jsonBodyOrEmpty(req('{"a":"x\\u0000y","n":{"m":["p\\u0000q",{"r":"\\u0000"}]}}'));
    expect(out).toEqual({ a: 'xy', n: { m: ['pq', { r: '' }] } });
  });

  it('strips NUL characters from object keys as well', async () => {
    const out = await jsonBodyOrEmpty(req('{"k\\u0000ey":1}'));
    expect(Object.keys(out)).toEqual(['key']);
  });

  it('keeps the prototype-pollution keys inert', async () => {
    const out = (await jsonBodyOrEmpty(req('{"__proto__":{"polluted":true},"constructor":{"prototype":{"p2":1}}}'))) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).p2).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it('is typed: the caller can name the shape it expects', async () => {
    const out = await jsonBodyOrEmpty<{ email?: string }>(req('{"email":"a@b.co"}'));
    expect(out.email).toBe('a@b.co');
  });
});

describe('stripNulChars', () => {
  it('removes NUL characters from query text', () => {
    expect(stripNulChars(new URL('http://x/?q=a%00b%00').searchParams.get('q') || '')).toBe('ab');
  });
  it('leaves clean text alone', () => {
    expect(stripNulChars('plain text')).toBe('plain text');
    expect(stripNulChars('')).toBe('');
  });
});

describe('the older helpers strip NUL characters too (an employee PATCH with one in a name answered 500)', () => {
  const nul = '{"name":"a\\u0000b","persona":{"tone":"x\\u0000y"}}';

  it('tryReadJson', async () => {
    expect(await tryReadJson(req(nul))).toEqual({ name: 'ab', persona: { tone: 'xy' } });
  });

  it('readJsonBody', async () => {
    const r = await readJsonBody(req(nul));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body).toEqual({ name: 'ab', persona: { tone: 'xy' } });
  });

  it('tryReadJson still answers null for invalid JSON and non-objects', async () => {
    expect(await tryReadJson(req('{"a":'))).toBeNull();
    expect(await tryReadJson(req('null'))).toBeNull();
    expect(await tryReadJson(req('[1]'))).toBeNull();
  });
});
