/**
 * @jest-environment node
 *
 * A WhatsApp reply goes out through the provider saved on the channel:
 * Meta Cloud for legacy/`meta-cloud` channels, Evolution for QR-linked ones.
 */
const query = jest.fn();
jest.mock('@/lib/db', () => ({
  pool: { query: jest.fn() },
  getOrgScopedClient: jest.fn(async () => ({ client: { query, release: jest.fn() }, orgId: 'org-1' })),
}));
jest.mock('@/lib/nango-server', () => ({ getNangoConnection: jest.fn() }));

import { replyTargetFromChannelMeta, sendChannelReply } from '@/lib/channel-outbound';
import { assertEvolutionWebhookSecret } from '@/lib/webhook-crypto';

const realFetch = global.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  query.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
  process.env.EVOLUTION_API_URL = 'http://evo.test';
  process.env.EVOLUTION_API_KEY = 'evo-key';
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.META_ACCESS_TOKEN;
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('sendChannelReply (whatsapp provider routing)', () => {
  it('sends QR-linked channels through Evolution', async () => {
    mockFetch(201, { key: { id: 'EVO1' } });
    const target = replyTargetFromChannelMeta('whatsapp', '919812345678', {
      provider: 'evolution',
      evolution_instance: 'darex-abc',
    });
    const r = await sendChannelReply('org-1', target, 'hello');
    expect(calls[0].url).toBe('http://evo.test/message/sendText/darex-abc');
    expect((calls[0].init.headers as Record<string, string>).apikey).toBe('evo-key');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ number: '919812345678', text: 'hello' });
    expect(r).toMatchObject({ attempted: true, sent: true, providerMessageId: 'EVO1' });
  });

  it('keeps legacy channels (no provider key) on Meta Graph', async () => {
    mockFetch(200, { messages: [{ id: 'wamid.1' }] });
    const target = replyTargetFromChannelMeta('whatsapp', '919812345678', {
      phone_number_id: '555',
      meta_access_token: 'tok',
    });
    const r = await sendChannelReply('org-1', target, 'hello');
    expect(calls[0].url).toBe('https://graph.facebook.com/v18.0/555/messages');
    expect(r).toMatchObject({ attempted: true, sent: true, providerMessageId: 'wamid.1' });
  });

  it('reports a failed Evolution send honestly', async () => {
    mockFetch(400, { response: { message: ['Connection Closed'] } });
    const target = replyTargetFromChannelMeta('whatsapp', '1', { provider: 'evolution', evolution_instance: 'darex-abc' });
    const r = await sendChannelReply('org-1', target, 'hello');
    expect(r.sent).toBe(false);
    expect(r.providerMessageId).toBeNull();
    expect(r.message).toMatch(/Connection Closed/);
  });
});

describe('assertEvolutionWebhookSecret', () => {
  it('refuses everything when no secret is configured', () => {
    delete process.env.EVOLUTION_WEBHOOK_SECRET;
    expect(assertEvolutionWebhookSecret('anything')).toMatchObject({ ok: false, status: 503 });
  });
  it('rejects a wrong or missing header, accepts the right one', () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = 's3cret';
    expect(assertEvolutionWebhookSecret(null)).toMatchObject({ ok: false, status: 401 });
    expect(assertEvolutionWebhookSecret('nope')).toMatchObject({ ok: false, status: 401 });
    expect(assertEvolutionWebhookSecret('s3cret')).toMatchObject({ ok: true });
  });
});
