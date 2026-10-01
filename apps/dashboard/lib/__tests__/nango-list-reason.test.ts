import { listNangoConnections } from '@/lib/nango-server';

const realFetch = global.fetch;
const realKey = process.env.NANGO_SECRET_KEY;

afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.NANGO_SECRET_KEY;
  else process.env.NANGO_SECRET_KEY = realKey;
});

function answer(status: number, body: unknown = []) {
  global.fetch = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body }) as never;
}

describe('listNangoConnections failure reason', () => {
  beforeEach(() => {
    process.env.NANGO_SECRET_KEY = 'k';
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('marks a rejected key as auth so callers skip per-connection probes', async () => {
    answer(401);
    await expect(listNangoConnections('org')).resolves.toMatchObject({ ok: false, reason: 'auth' });
    answer(403);
    await expect(listNangoConnections('org')).resolves.toMatchObject({ ok: false, reason: 'auth' });
  });

  it('keeps other HTTP failures probeable', async () => {
    answer(502);
    await expect(listNangoConnections('org')).resolves.toMatchObject({ ok: false, reason: 'error' });
  });

  it('marks a network failure as unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;
    await expect(listNangoConnections('org')).resolves.toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('has no reason when Nango answers', async () => {
    answer(200, { connections: [] });
    const res = await listNangoConnections('org');
    expect(res.ok).toBe(true);
    expect(res.reason).toBeUndefined();
  });
});
