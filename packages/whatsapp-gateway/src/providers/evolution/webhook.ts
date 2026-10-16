import type { InboundEvent, InboundMedia, ParsedWebhook } from '../../types.js';

type Json = Record<string, any>;

const MEDIA_KEYS: Array<[string, string]> = [
  ['audioMessage', 'audio'],
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
];

/** Digits for a phone JID, the full JID for anything else (e.g. unresolved @lid). */
export function contactFromJid(jid: string): string {
  return jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0] : jid;
}

function unwrap(message: Json): Json {
  return message?.ephemeralMessage?.message ?? message?.viewOnceMessage?.message ?? message ?? {};
}

function parseMessage(data: Json): InboundEvent | null {
  const key: Json = data.key ?? {};
  if (key.fromMe) return null;
  let jid = typeof key.remoteJid === 'string' ? key.remoteJid : '';
  if (jid.endsWith('@lid') && typeof key.remoteJidAlt === 'string') jid = key.remoteJidAlt;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return null;
  const messageId = typeof key.id === 'string' ? key.id : '';
  if (!messageId) return null;

  const msg = unwrap(data.message ?? {});
  const plain = msg.conversation ?? msg.extendedTextMessage?.text;
  let media: InboundMedia | null = null;
  for (const [field, type] of MEDIA_KEYS) {
    const blob = msg[field];
    if (blob && typeof blob === 'object') {
      media = {
        type,
        id: messageId,
        mimeType: typeof blob.mimetype === 'string' ? blob.mimetype : null,
        filename: typeof blob.fileName === 'string' ? blob.fileName : null,
        caption: typeof blob.caption === 'string' ? blob.caption : null,
        base64: typeof data.message?.base64 === 'string' && data.message.base64 ? data.message.base64 : null,
      };
      break;
    }
  }

  let text: string;
  if (typeof plain === 'string' && plain.trim()) {
    text = plain;
  } else if (media) {
    const parts = [`[${media.type} message]`, `media_id=${messageId}`];
    if (media.mimeType) parts.push(`mime=${media.mimeType}`);
    if (media.filename) parts.push(`filename=${media.filename}`);
    if (media.caption?.trim()) parts.push(media.caption.trim());
    text = parts.join(' ');
  } else {
    text = `[${typeof data.messageType === 'string' ? data.messageType : 'unknown'} message]`;
  }

  return {
    kind: 'message',
    from: contactFromJid(jid),
    messageId,
    text,
    media: media && !(typeof plain === 'string' && plain.trim()) ? media : null,
    pushName: typeof data.pushName === 'string' && data.pushName ? data.pushName : null,
  };
}

function parseStatus(data: Json): InboundEvent | null {
  if (!data.fromMe || typeof data.keyId !== 'string') return null;
  switch (String(data.status).toUpperCase()) {
    case 'SERVER_ACK':
      return { kind: 'status', messageId: data.keyId, status: 'sent' };
    case 'DELIVERY_ACK':
      return { kind: 'status', messageId: data.keyId, status: 'delivered' };
    case 'READ':
    case 'PLAYED':
      return { kind: 'status', messageId: data.keyId, status: 'read' };
    case 'ERROR':
      return { kind: 'status', messageId: data.keyId, status: 'failed' };
    default:
      return null;
  }
}

/** Normalise an Evolution webhook POST body into provider-neutral events. */
export function parseEvolutionWebhook(body: unknown): ParsedWebhook {
  const b = (body && typeof body === 'object' ? body : {}) as Json;
  const instance = typeof b.instance === 'string' && b.instance ? b.instance : null;
  const event = String(b.event ?? '').toLowerCase().replace(/_/g, '.');
  const rows: Json[] = Array.isArray(b.data) ? b.data : b.data && typeof b.data === 'object' ? [b.data] : [];
  const events: InboundEvent[] = [];

  for (const row of rows) {
    if (event === 'messages.upsert') {
      const e = parseMessage(row);
      if (e) events.push(e);
    } else if (event === 'messages.update') {
      const e = parseStatus(row);
      if (e) events.push(e);
    } else if (event === 'connection.update') {
      const s = row.state;
      if (s === 'open' || s === 'connecting' || s === 'close') {
        events.push({ kind: 'connection', state: s, loggedOut: s === 'close' && Number(row.statusReason) === 401 });
      }
    }
  }
  return { instance, events };
}
