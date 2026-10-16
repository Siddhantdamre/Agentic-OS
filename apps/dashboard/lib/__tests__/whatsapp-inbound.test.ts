/**
 * @jest-environment node
 *
 * Every WhatsApp provider webhook feeds ingestWhatsAppInbound. It must save the
 * message once, honour a human takeover, and hand the agent a reply target that
 * remembers which provider the channel uses (so the auto-reply goes out the
 * same way the customer wrote in).
 */
const query = jest.fn();
const release = jest.fn();
jest.mock('@/lib/db', () => ({
  pool: { query: jest.fn() },
  getOrgScopedClient: jest.fn(async () => ({ client: { query, release }, orgId: 'org-1' })),
}));
jest.mock('@/lib/nango-server', () => ({ getNangoConnection: jest.fn() }));
jest.mock('@/lib/realtime-hub', () => ({ realtimeHub: { publish: jest.fn() } }));

import { ingestWhatsAppInbound } from '@/lib/whatsapp-inbound';

type Opts = { dupMessage?: boolean; pausedUntil?: Date | null; existingConversation?: boolean };

function db(opts: Opts = {}) {
  query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT channel_type FROM channels')) return { rows: [{ channel_type: 'whatsapp' }] };
    if (sql.includes('FROM conversations')) {
      return {
        rows: opts.existingConversation
          ? [{ id: 'conv-1', employee_id: 'emp-1', ai_paused_until: opts.pausedUntil ?? null }]
          : [],
      };
    }
    if (sql.includes('FROM ai_employees')) {
      return {
        rows: [{ id: 'emp-1', name: 'Customer', role: 'Customer', persona: 'kind', tool_allowlist: ['whatsapp'] }],
      };
    }
    if (sql.includes('INSERT INTO conversations')) return { rows: [{ id: 'conv-1', employee_id: 'emp-1' }] };
    if (sql.includes('SELECT id FROM messages')) return { rows: opts.dupMessage ? [{ id: 'm-0' }] : [] };
    return { rows: [], rowCount: 1 };
  });
}

const base = {
  orgId: 'org-1',
  channelId: 'chan-1',
  channelMeta: { provider: 'evolution', evolution_instance: 'darex-abc' },
  newChannelMeta: {},
  from: '919812345678',
  messageId: 'MSG1',
  text: 'hello',
  media: null,
};

beforeEach(() => {
  release.mockReset();
});

describe('ingestWhatsAppInbound', () => {
  it('returns an agent job whose reply target keeps the channel provider', async () => {
    db();
    const job = await ingestWhatsAppInbound(base);
    expect(job).toMatchObject({
      orgId: 'org-1',
      conversationId: 'conv-1',
      employeeId: 'emp-1',
      userMessage: 'hello',
      inboundEventId: 'MSG1',
      channelKey: 'whatsapp',
      replyTarget: {
        channelType: 'whatsapp',
        contactId: '919812345678',
        whatsappMeta: { provider: 'evolution', evolution_instance: 'darex-abc' },
      },
    });
    expect(release).toHaveBeenCalled();
  });

  it('saves the message once: a duplicate delivery runs no agent', async () => {
    db({ existingConversation: true, dupMessage: true });
    expect(await ingestWhatsAppInbound(base)).toBeNull();
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO messages'));
    expect(inserts).toHaveLength(0);
  });

  it('saves the message but runs no agent while a human has taken over', async () => {
    db({ existingConversation: true, pausedUntil: new Date(Date.now() + 60_000) });
    expect(await ingestWhatsAppInbound(base)).toBeNull();
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO messages'));
    expect(inserts).toHaveLength(1);
  });

  it('a Meta channel (no provider key) still routes to Meta', async () => {
    db();
    const job = await ingestWhatsAppInbound({ ...base, channelMeta: { phone_number_id: '555' } });
    expect(job?.replyTarget?.whatsappMeta).toMatchObject({ provider: null, evolution_instance: null });
    expect(job?.replyTarget?.phoneNumberId).toBe('555');
  });

  it('hands the channel auto-reply settings to the job (default is the full agent)', async () => {
    db();
    const withDefault = await ingestWhatsAppInbound(base);
    expect(withDefault?.autoReply?.mode).toBe('agent');
    db();
    const simple = await ingestWhatsAppInbound({
      ...base,
      channelMeta: { ...base.channelMeta, auto_reply: { mode: 'ai_simple', instructions: 'Open 9-6' } },
    });
    expect(simple?.autoReply).toMatchObject({ mode: 'ai_simple', instructions: 'Open 9-6' });
  });

  it('auto-reply off: message is saved, no job', async () => {
    db();
    const job = await ingestWhatsAppInbound({
      ...base,
      channelMeta: { ...base.channelMeta, auto_reply: { mode: 'off' } },
    });
    expect(job).toBeNull();
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO messages'));
    expect(inserts).toHaveLength(1);
  });

  it('saves but does not reply to a number that is not on the allow list', async () => {
    db();
    const meta = { ...base.channelMeta, auto_reply: { mode: 'agent', audience: 'allow_list', numbers: ['919700000009'] } };
    expect(await ingestWhatsAppInbound({ ...base, channelMeta: meta })).toBeNull();
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO messages'))).toHaveLength(1);
    db();
    expect(await ingestWhatsAppInbound({ ...base, from: '919700000009', channelMeta: meta })).not.toBeNull();
  });

  it('only-new-conversations: a follow-up message in an open conversation gets no reply', async () => {
    const meta = { ...base.channelMeta, auto_reply: { mode: 'agent', replyTo: 'new_conversations' } };
    db();
    expect(await ingestWhatsAppInbound({ ...base, channelMeta: meta })).not.toBeNull();
    db({ existingConversation: true });
    expect(await ingestWhatsAppInbound({ ...base, messageId: 'MSG2', channelMeta: meta })).toBeNull();
  });

  it('owner instructions reach the AI employee persona', async () => {
    db();
    const job = await ingestWhatsAppInbound({
      ...base,
      channelMeta: { ...base.channelMeta, auto_reply: { mode: 'agent', instructions: 'Never promise discounts.' } },
    });
    expect(job?.employeePersona).toContain('Never promise discounts.');
  });

  it('uses the AI employee the owner picked for a new conversation', async () => {
    db();
    const picked = '33333333-3333-4333-8333-333333333333';
    await ingestWhatsAppInbound({
      ...base,
      channelMeta: { ...base.channelMeta, auto_reply: { mode: 'agent', employeeId: picked } },
    });
    const lookups = query.mock.calls.filter(([sql]) => String(sql).includes('AND id = $2'));
    expect(lookups[0][1]).toEqual(['org-1', picked]);
  });

  it('without a pick, a customer or support employee is preferred over the oldest one', async () => {
    db();
    await ingestWhatsAppInbound(base);
    const auto = query.mock.calls.find(([sql]) => String(sql).includes("(role ~* '(customer|support)') DESC"));
    expect(auto).toBeDefined();
  });

  it('reads voice notes and images unless the owner turned that off', async () => {
    const voice = { type: 'audio', id: 'A1', mimeType: 'audio/ogg', sha256: null, filename: null, caption: null };
    db();
    const on = await ingestWhatsAppInbound({ ...base, media: voice, mediaBase64: 'QUJD' });
    expect(on?.media).toMatchObject({ type: 'audio', base64: 'QUJD' });
    db();
    const off = await ingestWhatsAppInbound({
      ...base,
      media: voice,
      mediaBase64: 'QUJD',
      channelMeta: { ...base.channelMeta, auto_reply: { mode: 'agent', readMedia: false } },
    });
    expect(off?.media).toBeUndefined();
  });
});
