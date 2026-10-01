import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { SecretError, isSealed, openSecret, sealSecret, secretHint, secretsKeyConfigured, completeEmbeddedSignup, fetchWhatsAppMedia, parseEvolutionWebhook, evolutionInstanceName, providerIdOf, sendWhatsApp, getWhatsAppProvider } from './index.js';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  process.env.EVOLUTION_API_URL = 'http://evo:8080/';
  process.env.EVOLUTION_API_KEY = 'k';
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const upsert = (data: unknown) => ({ event: 'messages.upsert', instance: 'darex-1', data });
const msg = (over: Record<string, unknown> = {}) => ({
  key: { remoteJid: '919876543210@s.whatsapp.net', fromMe: false, id: 'ABC' },
  pushName: 'Asha',
  messageType: 'conversation',
  message: { conversation: 'hi there' },
  ...over,
});

test('registry: legacy meta has no provider -> meta-cloud', () => {
  assert.equal(providerIdOf({ phone_number_id: '1' }), 'meta-cloud');
  assert.equal(providerIdOf({ provider: 'evolution' }), 'evolution');
  assert.equal(providerIdOf({ provider: 'nope' }), 'meta-cloud');
  assert.equal(getWhatsAppProvider(null).id, 'meta-cloud');
});

test('parse: text message, contact digits, instance', () => {
  const p = parseEvolutionWebhook(upsert(msg()));
  assert.equal(p.instance, 'darex-1');
  assert.deepEqual(p.events, [
    { kind: 'message', from: '919876543210', messageId: 'ABC', text: 'hi there', media: null, pushName: 'Asha' },
  ]);
});

test('parse: event name in MESSAGES_UPSERT form, extendedText, array data', () => {
  const p = parseEvolutionWebhook({
    event: 'MESSAGES_UPSERT',
    instance: 'i',
    data: [msg({ message: { extendedTextMessage: { text: 'long one' } } })],
  });
  assert.equal((p.events[0] as any).text, 'long one');
});

test('parse: skips own, group and status messages', () => {
  const own = msg({ key: { remoteJid: '1@s.whatsapp.net', fromMe: true, id: 'x' } });
  const grp = msg({ key: { remoteJid: '1-2@g.us', fromMe: false, id: 'y' } });
  const sts = msg({ key: { remoteJid: 'status@broadcast', fromMe: false, id: 'z' } });
  for (const m of [own, grp, sts]) assert.equal(parseEvolutionWebhook(upsert(m)).events.length, 0);
});

test('parse: @lid uses remoteJidAlt, else keeps the jid', () => {
  const alt = msg({ key: { remoteJid: '55@lid', remoteJidAlt: '919000000001@s.whatsapp.net', fromMe: false, id: 'a' } });
  assert.equal((parseEvolutionWebhook(upsert(alt)).events[0] as any).from, '919000000001');
  const bare = msg({ key: { remoteJid: '55@lid', fromMe: false, id: 'b' } });
  assert.equal((parseEvolutionWebhook(upsert(bare)).events[0] as any).from, '55@lid');
});

test('parse: media without caption is described, never transcribed', () => {
  const m = msg({ messageType: 'audioMessage', message: { audioMessage: { mimetype: 'audio/ogg' } } });
  const e = parseEvolutionWebhook(upsert(m)).events[0] as any;
  assert.equal(e.text, '[audio message] media_id=ABC mime=audio/ogg');
  assert.equal(e.media.type, 'audio');
});

test('parse: delivery status only for our own outbound messages', () => {
  const st = (status: string, fromMe = true) => ({
    event: 'messages.update',
    instance: 'i',
    data: { keyId: 'K', fromMe, status },
  });
  const map = (s: string) => (parseEvolutionWebhook(st(s)).events[0] as any)?.status;
  assert.equal(map('SERVER_ACK'), 'sent');
  assert.equal(map('DELIVERY_ACK'), 'delivered');
  assert.equal(map('READ'), 'read');
  assert.equal(map('ERROR'), 'failed');
  assert.equal(map('PENDING'), undefined);
  assert.equal(parseEvolutionWebhook(st('READ', false)).events.length, 0);
});

test('parse: connection.update and junk input', () => {
  const c = parseEvolutionWebhook({ event: 'connection.update', instance: 'i', data: { state: 'open' } });
  assert.deepEqual(c.events, [{ kind: 'connection', state: 'open', loggedOut: false }]);
  const drop = (reason: number) =>
    parseEvolutionWebhook({ event: 'connection.update', instance: 'i', data: { state: 'close', statusReason: reason } });
  assert.equal((drop(401).events[0] as any).loggedOut, true);
  assert.equal((drop(428).events[0] as any).loggedOut, false);
  assert.deepEqual(parseEvolutionWebhook(null), { instance: null, events: [] });
  assert.deepEqual(parseEvolutionWebhook({ event: 'qrcode.updated', data: {} }).events, []);
});

test('send meta-cloud: Graph URL, body, wamid', async () => {
  mockFetch(200, { messages: [{ id: 'wamid.X' }] });
  const r = await sendWhatsApp({ phone_number_id: '111', meta_access_token: 'tok' }, { to: '9198', text: 'yo' });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v18.0/111/messages');
  assert.equal((calls[0].init.headers as any).Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    messaging_product: 'whatsapp',
    to: '9198',
    type: 'text',
    text: { body: 'yo' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 'wamid.X');
});

test('send meta-cloud: no creds -> not attempted', async () => {
  const r = await sendWhatsApp({}, { to: '1', text: 'x' });
  assert.equal(r.attempted, false);
  assert.equal(calls.length, 0);
});

test('send evolution: URL, apikey header, body, key.id', async () => {
  mockFetch(201, { key: { id: 'EVO1' } });
  const r = await sendWhatsApp({ provider: 'evolution', evolution_instance: 'darex-1' }, { to: '9198', text: 'yo' });
  assert.equal(calls[0].url, 'http://evo:8080/message/sendText/darex-1');
  assert.equal((calls[0].init.headers as any).apikey, 'k');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { number: '9198', text: 'yo' });
  assert.equal(r.messageId, 'EVO1');
});

test('send evolution: failure surfaces the API message, no id', async () => {
  mockFetch(400, { response: { message: ['Connection Closed'] } });
  const r = await sendWhatsApp({ provider: 'evolution', evolution_instance: 'darex-1' }, { to: '1', text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.messageId, null);
  assert.match(r.message, /Connection Closed/);
});

test('send evolution: server env missing -> not attempted', async () => {
  delete process.env.EVOLUTION_API_URL;
  const r = await sendWhatsApp({ provider: 'evolution', evolution_instance: 'darex-1' }, { to: '1', text: 'x' });
  assert.equal(r.attempted, false);
});

test('parse: inline base64 rides on the media, not in the text', () => {
  const m = msg({
    messageType: 'audioMessage',
    message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' }, base64: 'QUJD' },
  });
  const e = parseEvolutionWebhook(upsert(m)).events[0] as any;
  assert.equal(e.media.base64, 'QUJD');
  assert.ok(!e.text.includes('QUJD'));
});

test('media: inline base64 decodes without a network call', async () => {
  const f = await fetchWhatsAppMedia({ provider: 'evolution' }, { type: 'audio', id: 'x', mimeType: 'audio/ogg', filename: null, caption: null, base64: 'QUJD' });
  assert.equal(f?.data.toString(), 'ABC');
  assert.equal(f?.mimeType, 'audio/ogg');
  assert.equal(calls.length, 0);
});

test('media meta-cloud: id -> url -> bytes with bearer on both calls', async () => {
  let n = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    n += 1;
    return n === 1
      ? new Response(JSON.stringify({ url: 'https://lookaside.example/f', mime_type: 'audio/ogg' }), { status: 200 })
      : new Response(Buffer.from('VOICE'), { status: 200 });
  }) as typeof fetch;
  const f = await fetchWhatsAppMedia({ phone_number_id: '1', meta_access_token: 'tok' }, { type: 'audio', id: 'MID', mimeType: null, filename: null, caption: null });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v18.0/MID');
  assert.equal((calls[1].init.headers as any).Authorization, 'Bearer tok');
  assert.equal(f?.data.toString(), 'VOICE');
  assert.equal(f?.mimeType, 'audio/ogg');
});

test('media meta-cloud: no token or a failed lookup gives null', async () => {
  assert.equal(await fetchWhatsAppMedia({}, { type: 'audio', id: 'MID', mimeType: null, filename: null, caption: null }), null);
  mockFetch(404, {});
  assert.equal(await fetchWhatsAppMedia({ meta_access_token: 't' }, { type: 'audio', id: 'MID', mimeType: null, filename: null, caption: null }), null);
});

const OUTSIDE = { error: { code: 131047, message: 'Re-engagement message' } };

test('meta-cloud: closed 24h window fails honestly with an actionable code', async () => {
  mockFetch(400, OUTSIDE);
  const r = await sendWhatsApp({ phone_number_id: '1', meta_access_token: 't' }, { to: '9198', text: 'late' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'outside_window');
  assert.equal(r.messageId, null);
  assert.match(r.message, /24-hour reply window/);
  assert.equal(calls.length, 1);
});

test('meta-cloud: closed window sends the fallback template when configured', async () => {
  let n = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    n += 1;
    return n === 1
      ? new Response(JSON.stringify(OUTSIDE), { status: 400 })
      : new Response(JSON.stringify({ messages: [{ id: 'wamid.T' }] }), { status: 200 });
  }) as typeof fetch;
  const meta = { phone_number_id: '1', meta_access_token: 't', fallback_template: { name: 'we_will_reply', language: 'en_US' } };
  const r = await sendWhatsApp(meta, { to: '9198', text: 'late' });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    messaging_product: 'whatsapp',
    to: '9198',
    type: 'template',
    template: { name: 'we_will_reply', language: { code: 'en_US' } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.messageId, 'wamid.T');
  assert.match(r.message, /template "we_will_reply"/);
});

test('meta-cloud: a malformed fallback template is ignored', async () => {
  mockFetch(400, OUTSIDE);
  const meta = { phone_number_id: '1', meta_access_token: 't', fallback_template: { name: 'Bad Name!', language: 'en' } };
  const r = await sendWhatsApp(meta, { to: '9198', text: 'late' });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
});

const signup = { code: 'CODE', wabaId: '1112223334', phoneNumberId: '5556667778', appId: 'APP', appSecret: 'SEC' };

function graphSequence(...responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}

test('embedded signup: exchanges the code, checks the phone belongs to the WABA, subscribes webhooks', async () => {
  graphSequence(
    { status: 200, body: { access_token: 'BIZTOKEN' } },
    { status: 200, body: { data: [{ id: '5556667778' }] } },
    { status: 200, body: { success: true } }
  );
  const r = await completeEmbeddedSignup(signup);
  assert.equal(r.ok, true);
  assert.equal((r as any).accessToken, 'BIZTOKEN');
  assert.equal((r as any).webhookSubscribed, true);
  assert.match(calls[0].url, /oauth\/access_token\?client_id=APP&client_secret=SEC&code=CODE/);
  assert.equal((calls[1].init.headers as any).Authorization, 'Bearer BIZTOKEN');
  assert.match(calls[2].url, /1112223334\/subscribed_apps/);
});

test('embedded signup: refuses a phone id the token cannot see (client-supplied ids are untrusted)', async () => {
  graphSequence({ status: 200, body: { access_token: 'T' } }, { status: 200, body: { data: [{ id: '999999999' }] } });
  const r = await completeEmbeddedSignup(signup);
  assert.equal(r.ok, false);
  assert.equal((r as any).status, 403);
  assert.equal(calls.length, 2);
});

test('embedded signup: bad code or malformed ids fail before any token is used', async () => {
  graphSequence({ status: 400, body: { error: { message: 'Invalid verification code' } } });
  const bad = await completeEmbeddedSignup(signup);
  assert.equal(bad.ok, false);
  assert.match((bad as any).message, /Invalid verification code/);
  calls = [];
  const junk = await completeEmbeddedSignup({ ...signup, wabaId: '../x' });
  assert.equal(junk.ok, false);
  assert.equal(calls.length, 0);
});

const KEY = 'a'.repeat(64);

test('secrets: seal then open round-trips and never stores plaintext', () => {
  process.env.CHANNEL_SECRETS_KEY = KEY;
  const sealed = sealSecret('EAAGtoken123');
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes('EAAGtoken123'));
  assert.equal(openSecret(sealed), 'EAAGtoken123');
  assert.notEqual(sealSecret('EAAGtoken123'), sealed, 'fresh iv each time');
});

test('secrets: legacy plaintext passes through, tampering and wrong key fail loudly', () => {
  process.env.CHANNEL_SECRETS_KEY = KEY;
  assert.equal(openSecret('EAAGplain'), 'EAAGplain');
  const sealed = sealSecret('EAAGtoken123');
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => openSecret(tampered), SecretError);
  process.env.CHANNEL_SECRETS_KEY = 'b'.repeat(64);
  assert.throws(() => openSecret(sealed), /wrong CHANNEL_SECRETS_KEY/);
  delete process.env.CHANNEL_SECRETS_KEY;
  assert.equal(secretsKeyConfigured(), false);
  assert.throws(() => sealSecret('x'), /not set/);
  assert.throws(() => openSecret(sealed), /not set/);
});

test('secrets: hint shows the ends only', () => {
  assert.equal(secretHint('EAAGabcdefghijklmnop9Zk1'), 'EAAG…9Zk1');
  assert.equal(secretHint('short'), '…');
});

test('meta-cloud: sends with a sealed stored token (opened on use)', async () => {
  process.env.CHANNEL_SECRETS_KEY = KEY;
  mockFetch(200, { messages: [{ id: 'wamid.S' }] });
  const meta = { phone_number_id: '111', meta_access_token: sealSecret('REALTOKEN') };
  const r = await sendWhatsApp(meta, { to: '9198', text: 'yo' });
  assert.equal((calls[0].init.headers as any).Authorization, 'Bearer REALTOKEN');
  assert.equal(r.ok, true);
  delete process.env.CHANNEL_SECRETS_KEY;
});

test('meta-cloud: a sealed token that cannot be opened is reported, nothing is sent', async () => {
  process.env.CHANNEL_SECRETS_KEY = KEY;
  const meta = { phone_number_id: '111', meta_access_token: sealSecret('REALTOKEN') };
  process.env.CHANNEL_SECRETS_KEY = 'c'.repeat(64);
  const r = await sendWhatsApp(meta, { to: '9198', text: 'yo' });
  assert.equal(r.attempted, false);
  assert.match(r.message, /token cannot be read/);
  assert.equal(calls.length, 0);
  delete process.env.CHANNEL_SECRETS_KEY;
});

test('evolution: a slow gateway is reported as a timeout, not a raw abort', async () => {
  globalThis.fetch = (async () => {
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    throw e;
  }) as typeof fetch;
  const r = await sendWhatsApp({ provider: 'evolution', evolution_instance: 'darex-abc' }, { to: '1', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not answer in time/);
});

test('evolution instance name: primary has no suffix, extra numbers add their key', () => {
  const org = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(evolutionInstanceName(org), 'darex-aaaaaaaabbbbccccddddeeeeeeeeeeee');
  assert.equal(evolutionInstanceName(org, 'n1a2b3c'), 'darex-aaaaaaaabbbbccccddddeeeeeeeeeeee-n1a2b3c');
});
