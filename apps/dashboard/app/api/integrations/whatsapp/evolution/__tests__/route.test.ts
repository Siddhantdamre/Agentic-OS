/**
 * @jest-environment node
 *
 * The modal polls this while a QR is on screen. It must move on as soon as the
 * phone is linked, whether we learn that from the Evolution webhook (already in
 * the database) or from Evolution's own connection state.
 */
const query = jest.fn();
jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { query, release: jest.fn() }, orgId: 'org-1', userId: 'u-1' })),
  scopedAuthErrorResponse: () => null,
}));
jest.mock('@/lib/connector-rbac', () => ({
  denyUnlessConnectorManager: jest.fn(async () => null),
  auditConnectorChange: jest.fn(),
}));
jest.mock('@/lib/connector-registry', () => ({ upsertOrgConnector: jest.fn() }));

import { GET } from '../route';

const realFetch = global.fetch;
let urls: string[] = [];

function evolutionState(state: string) {
  global.fetch = jest.fn(async (url: unknown) => {
    urls.push(String(url));
    if (String(url).includes('/instance/connectionState/')) {
      return new Response(JSON.stringify({ instance: { state } }), { status: 200 });
    }
    return new Response(JSON.stringify([{ ownerJid: '919812345678@s.whatsapp.net', profileName: 'Acme' }]), { status: 200 });
  }) as unknown as typeof fetch;
}

const CHAN = '11111111-2222-3333-4444-555555555555';
const channel = (status: string) =>
  query.mockImplementation(async (sql: string) => {
    if (String(sql).includes('SELECT id, account_key, status, meta')) {
      return { rows: [{ id: CHAN, account_key: '', status, meta: { provider: 'evolution', evolution_instance: 'darex-abc' } }] };
    }
    if (String(sql).includes("SET status = 'connected'")) {
      return { rows: [{ instance: 'darex-abc', account_key: '' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });

beforeEach(() => {
  urls = [];
  query.mockReset();
  process.env.EVOLUTION_API_URL = 'http://evo.test';
  process.env.EVOLUTION_API_KEY = 'k';
});
afterEach(() => {
  global.fetch = realFetch;
});

const get = (qs = '') => GET(new Request(`http://x/api/integrations/whatsapp/evolution${qs}`));

describe('GET /api/integrations/whatsapp/evolution', () => {
  it('reports connected at once when the webhook already linked the phone', async () => {
    channel('connected');
    evolutionState('connecting');
    const body = await (await get()).json();
    expect(body).toMatchObject({ provider: 'evolution', state: 'open', connected: true });
    expect(urls).toHaveLength(0);
  });

  it('reports connected when Evolution says open, and records the link', async () => {
    channel('pairing');
    evolutionState('open');
    const body = await (await get()).json();
    expect(body.connected).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'connected'"))).toBe(true);
  });

  it('keeps waiting while Evolution is still connecting', async () => {
    channel('pairing');
    evolutionState('connecting');
    const body = await (await get()).json();
    expect(body).toMatchObject({ state: 'connecting', connected: false });
  });

  it('looks up the number named by ?channelId, not just the primary', async () => {
    channel('connected');
    await get(`?channelId=${CHAN}`);
    const lookup = query.mock.calls.find(([sql]) => String(sql).includes('SELECT id, account_key, status, meta'));
    expect(String(lookup?.[0])).toContain('AND id = $2');
    expect(lookup?.[1]).toEqual(['org-1', CHAN]);
  });

  it('refuses a channelId that is not a uuid', async () => {
    const res = await get('?channelId=abc');
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('says none when this org has no QR link', async () => {
    query.mockResolvedValue({ rows: [] });
    const body = await (await get()).json();
    expect(body).toMatchObject({ state: 'none', connected: false });
  });
});
