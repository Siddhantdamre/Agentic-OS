/**
 * @jest-environment node
 *
 * Razorpay BYOK connect (RT-S04 / BIZ-S01): the key secret is verified with
 * Razorpay, then stored sealed under both legacy key names, never plaintext.
 */
const query = jest.fn();
const release = jest.fn();
jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { query, release }, orgId: 'org-1', userId: 'u-1' })),
  scopedAuthErrorResponse: jest.fn(() => null),
}));
jest.mock('@/lib/connector-rbac', () => ({
  denyUnlessConnectorManager: jest.fn(async () => null),
  auditConnectorChange: jest.fn(),
}));
jest.mock('@/lib/connector-registry', () => ({ upsertOrgConnector: jest.fn() }));
jest.mock('@/lib/realtime-hub', () => ({ realtimeHub: { publish: jest.fn() } }));

import { openSecret } from '@darex/whatsapp-gateway';
import { POST } from '@/app/api/integrations/razorpay/route';

const SECRET = 'rzp_secret_abcdefghijkl';
const req = () =>
  new Request('http://x/api/integrations/razorpay', {
    method: 'POST',
    body: JSON.stringify({ keyId: 'rzp_live_123', keySecret: SECRET }),
  });
const inserted = () => query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO channels'));

beforeEach(() => {
  process.env.CHANNEL_SECRETS_KEY = 'b'.repeat(64);
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  global.fetch = jest.fn(async () => new Response('{"items":[]}', { status: 200 })) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

const realFetch = global.fetch;
/** Basic auth Razorpay was called with. */
const sentAuth = () => {
  const init = (global.fetch as jest.Mock).mock.calls[0]?.[1] as RequestInit | undefined;
  const h = new Headers(init?.headers);
  return Buffer.from(String(h.get('authorization')).replace(/^Basic /, ''), 'base64').toString();
};

describe('POST /api/integrations/razorpay', () => {
  it('stores the verified key secret sealed, with a safe hint', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(sentAuth()).toBe(`rzp_live_123:${SECRET}`);
    const saved = JSON.parse(inserted()![1][1]);
    expect(saved.keySecret).toMatch(/^enc:v1\./);
    expect(saved.key_secret).toBe(saved.keySecret);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(openSecret(saved.keySecret)).toBe(SECRET);
    expect(saved.secret_hint).toBe('rzp_…ijkl');
    expect(saved.keyId).toBe('rzp_live_123');
  });

  it('refuses to store a secret it cannot encrypt, before calling Razorpay', async () => {
    delete process.env.CHANNEL_SECRETS_KEY;
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(inserted()).toBeUndefined();
  });
});
