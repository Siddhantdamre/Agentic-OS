/**
 * @jest-environment node
 *
 * Voice notes and images are read by a model so the reply can use them.
 * Never invents: any failure returns null and the caller keeps metadata only.
 */
const query = jest.fn();
jest.mock('@/lib/db', () => ({
  pool: { query: jest.fn() },
  getOrgScopedClient: jest.fn(async () => ({ client: { query, release: jest.fn() }, orgId: 'org-1' })),
}));

import { readWhatsAppMedia } from '@/lib/whatsapp-media';

const realFetch = global.fetch;
let bodies: any[] = [];

function llm(status: number, content: string) {
  global.fetch = jest.fn(async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as unknown as typeof fetch;
}

const base = {
  orgId: 'org-1',
  conversationId: 'conv-1',
  providerMessageId: 'MSG1',
  channelMeta: { provider: 'evolution', evolution_instance: 'darex-x' },
};
const audio = { type: 'audio', id: 'MSG1', mimeType: 'audio/ogg; codecs=opus', filename: null, caption: null, base64: 'QUJD' };
const image = { type: 'image', id: 'MSG2', mimeType: 'image/png', filename: null, caption: 'my bill', base64: 'QUJD' };

beforeEach(() => {
  bodies = [];
  query.mockReset().mockResolvedValue({ rowCount: 1, rows: [] });
  process.env.LITELLM_BASE_URL = 'http://litellm.test/v1';
  process.env.LITELLM_API_KEY = 'k';
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('readWhatsAppMedia', () => {
  it('transcribes a voice note and saves the transcript on the message', async () => {
    llm(200, 'Do you have a 2BHK?');
    const text = await readWhatsAppMedia({ ...base, media: audio });
    expect(text).toBe('[voice note] Do you have a 2BHK?');
    const part = bodies[0].messages[0].content[1];
    expect(part).toEqual({ type: 'input_audio', input_audio: { data: 'QUJD', format: 'ogg' } });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE messages');
    expect(params).toEqual(['[voice note] Do you have a 2BHK?', 'Do you have a 2BHK?', 'org-1', 'conv-1', 'MSG1']);
  });

  it('describes an image and keeps the customer caption', async () => {
    llm(200, 'A phone bill showing 1,240 rupees due.');
    const text = await readWhatsAppMedia({ ...base, providerMessageId: 'MSG2', media: image });
    expect(text).toBe('[image] A phone bill showing 1,240 rupees due. Caption: my bill');
    expect(bodies[0].messages[0].content[1].image_url.url).toBe('data:image/png;base64,QUJD');
  });

  it('leaves other file types alone', async () => {
    llm(200, 'x');
    expect(await readWhatsAppMedia({ ...base, media: { ...audio, type: 'video' } })).toBeNull();
    expect(await readWhatsAppMedia({ ...base, media: { ...audio, type: 'document' } })).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  it('returns null, saves nothing, when the model fails or says nothing', async () => {
    llm(500, 'boom');
    expect(await readWhatsAppMedia({ ...base, media: audio })).toBeNull();
    llm(200, '');
    expect(await readWhatsAppMedia({ ...base, media: audio })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('skips files over 10 MB', async () => {
    llm(200, 'x');
    const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
    expect(await readWhatsAppMedia({ ...base, media: { ...audio, base64: big } })).toBeNull();
    expect(bodies).toHaveLength(0);
  });
});
