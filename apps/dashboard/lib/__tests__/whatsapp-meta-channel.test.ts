/**
 * @jest-environment node
 *
 * Both Meta connect routes (paste a token, Embedded Signup) end here: verify
 * the credentials with Meta, unlink any QR number, save provider `meta-cloud`.
 */
jest.mock('@/lib/connector-registry', () => ({ upsertOrgConnector: jest.fn() }));
jest.mock('@/lib/connector-rbac', () => ({ auditConnectorChange: jest.fn() }));

import { openSecret } from '@darex/whatsapp-gateway';
import { saveMetaCloudChannel } from '@/lib/whatsapp-meta-channel';

const query = jest.fn();
const client = { query } as never;
const input = { orgId: 'org-1', userId: 'u-1', accessToken: 'tok', phoneNumberId: '555', wabaId: '777', authMode: 'embedded_signup' as const };

const realFetch = global.fetch;
let urls: string[] = [];
let metaOk = true;
let evoOk = true;

beforeEach(() => {
  urls = [];
  metaOk = true;
  evoOk = true;
  process.env.CHANNEL_SECRETS_KEY = 'a'.repeat(64);
  process.env.EVOLUTION_API_URL = 'http://evo.test';
  process.env.EVOLUTION_API_KEY = 'k';
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  global.fetch = jest.fn(async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    if (u.startsWith('https://graph.facebook.com')) {
      return metaOk
        ? new Response(JSON.stringify({ verified_name: 'Acme' }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), { status: 401 });
    }
    return evoOk ? new Response('{}', { status: 200 }) : new Response('{"message":"boom"}', { status: 500 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

const inserted = () => query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO channels'));
const priorQr = () =>
  query.mockImplementation(async (sql: string) =>
    String(sql).includes('SELECT meta FROM channels')
      ? { rows: [{ meta: { provider: 'evolution', evolution_instance: 'darex-abc' } }] }
      : { rows: [], rowCount: 0 }
  );

describe('saveMetaCloudChannel', () => {
  it('saves credentials as provider meta-cloud once Meta accepts them', async () => {
    const res = await saveMetaCloudChannel(client, input);
    expect(res.status).toBe(200);
    const saved = JSON.parse(inserted()![1][1]);
    expect(saved).toMatchObject({ provider: 'meta-cloud', phoneNumberId: '555', wabaId: '777', display_phone_number: null });
    // The token is stored encrypted under both legacy keys, with a safe hint.
    expect(saved.accessToken).toMatch(/^enc:v1\./);
    expect(saved.meta_access_token).toBe(saved.accessToken);
    expect(JSON.stringify(saved)).not.toContain('"tok"');
    expect(openSecret(saved.accessToken)).toBe('tok');
    expect(saved.token_hint).toBe('…');
    expect(String(inserted()![0])).toContain("- 'evolution_instance'");
  });

  it('refuses to save a token it cannot encrypt', async () => {
    delete process.env.CHANNEL_SECRETS_KEY;
    const res = await saveMetaCloudChannel(client, input);
    expect(res.status).toBe(503);
    expect(inserted()).toBeUndefined();
    expect(urls).toHaveLength(0);
  });

  it('stores the number Meta reports so the card can show it', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(async () =>
      new Response(JSON.stringify({ verified_name: 'Sunrise Realty', display_phone_number: '+91 98123 45678' }), { status: 200 })
    );
    await saveMetaCloudChannel(client, { ...input, accessToken: 'EAAGabcdefghijklmnop9Zk1' });
    const saved = JSON.parse(inserted()![1][1]);
    expect(saved).toMatchObject({ display_phone_number: '+91 98123 45678', verified_name: 'Sunrise Realty', token_hint: 'EAAG…9Zk1' });
  });

  it('saves nothing and reports why when Meta rejects the token', async () => {
    metaOk = false;
    const res = await saveMetaCloudChannel(client, input);
    expect(res.status).toBe(400);
    expect(inserted()).toBeUndefined();
  });

  it('unlinks a QR number before switching to the official API', async () => {
    priorQr();
    const res = await saveMetaCloudChannel(client, input);
    expect(urls).toContain('http://evo.test/instance/delete/darex-abc');
    expect(res.status).toBe(200);
    expect(inserted()).toBeDefined();
  });

  it('keeps the QR link if it cannot be unlinked', async () => {
    priorQr();
    evoOk = false;
    const res = await saveMetaCloudChannel(client, input);
    expect(res.status).toBe(502);
    expect(inserted()).toBeUndefined();
  });
});
