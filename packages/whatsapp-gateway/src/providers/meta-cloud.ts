import { fetchWithRetry, fetchWithTimeout, metaString } from '../http.js';
import { openSecret } from '../secrets.js';
import type { ChannelMeta, InboundMedia, MediaFile, SendInput, SendResult, WhatsAppProvider } from '../types.js';

const GRAPH_VERSION = 'v18.0';

/** Token comes from meta already decrypted-on-read; a token that cannot be opened counts as missing. */
function creds(meta: ChannelMeta): { phoneNumberId: string | null; accessToken: string | null; tokenError: string | null } {
  const phoneNumberId = metaString(meta, 'phone_number_id', 'phoneNumberId');
  const stored = metaString(meta, 'meta_access_token', 'accessToken');
  if (!stored) return { phoneNumberId, accessToken: null, tokenError: null };
  try {
    return { phoneNumberId, accessToken: openSecret(stored), tokenError: null };
  } catch (err) {
    return { phoneNumberId, accessToken: null, tokenError: err instanceof Error ? err.message : String(err) };
  }
}

/** `{ messages: [{ id: "wamid..." }] }` */
export function wamidFromResponse(body: string): string | null {
  try {
    const id = (JSON.parse(body) as { messages?: Array<{ id?: unknown }> })?.messages?.[0]?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Meta error 131047: more than 24 hours since the customer last wrote, free text is refused. */
const OUTSIDE_WINDOW = 131047;

export function metaErrorCode(body: string): number | null {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'number' ? code : null;
  } catch {
    return null;
  }
}

/** `meta.fallback_template` = { name, language }: an approved template with no variables. */
export function fallbackTemplate(meta: ChannelMeta): { name: string; language: string } | null {
  const t = meta.fallback_template as { name?: unknown; language?: unknown } | null | undefined;
  if (!t || typeof t.name !== 'string' || typeof t.language !== 'string') return null;
  return /^[a-z0-9_]{1,512}$/.test(t.name) && /^[a-z]{2,3}(_[A-Z]{2})?$/.test(t.language)
    ? { name: t.name, language: t.language }
    : null;
}

/** Official WhatsApp Cloud API (Meta Graph). Inbound is handled by /api/webhooks/whatsapp. */
export const metaCloud: WhatsAppProvider = {
  id: 'meta-cloud',
  label: 'Official WhatsApp Business API (Meta Cloud)',

  canSend(meta) {
    const c = creds(meta);
    return Boolean(c.phoneNumberId && c.accessToken);
  },

  /** Graph media: id -> short-lived URL -> bytes (both calls need the bearer token). */
  async fetchMedia(meta: ChannelMeta, media: InboundMedia): Promise<MediaFile | null> {
    const { accessToken } = creds(meta);
    if (!accessToken || !media.id) return null;
    try {
      const auth = { Authorization: `Bearer ${accessToken}` };
      const info = await fetchWithTimeout(`https://graph.facebook.com/${GRAPH_VERSION}/${media.id}`, { headers: auth }, 15000);
      if (!info.ok) return null;
      const { url, mime_type } = (await info.json()) as { url?: string; mime_type?: string };
      if (!url) return null;
      const file = await fetchWithTimeout(url, { headers: auth }, 30000);
      if (!file.ok) return null;
      return { data: Buffer.from(await file.arrayBuffer()), mimeType: mime_type || media.mimeType || 'application/octet-stream' };
    } catch {
      return null;
    }
  },

  async send(meta: ChannelMeta, input: SendInput): Promise<SendResult> {
    const { phoneNumberId, accessToken, tokenError } = creds(meta);
    if (!phoneNumberId || !accessToken) {
      return {
        attempted: false,
        ok: false,
        status: 0,
        messageId: null,
        message: tokenError
          ? `WhatsApp token cannot be read (${tokenError}). Reconnect at /connectors.`
          : 'WhatsApp not connected - missing phone_number_id or access token. Connect at /connectors.',
        body: '',
      };
    }
    try {
      const res = await fetchWithRetry(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: input.to,
          type: 'text',
          text: { body: input.text },
        }),
      });
      const body = await res.text().catch(() => '');
      if (!res.ok && metaErrorCode(body) === OUTSIDE_WINDOW) return await outsideWindow(meta, input, phoneNumberId, accessToken, res.status, body);
      return {
        attempted: true,
        ok: res.ok,
        status: res.status,
        messageId: res.ok ? wamidFromResponse(body) : null,
        message: res.ok ? `AI reply to ${input.to}` : `Meta Graph send failed: ${body.slice(0, 200)}`,
        body: body.slice(0, 500),
      };
    } catch (err: unknown) {
      return {
        attempted: true,
        ok: false,
        status: 0,
        messageId: null,
        message: `Meta Graph send error: ${err instanceof Error ? err.message : String(err)}`,
        body: '',
      };
    }
  },
};


/**
 * The 24-hour window is closed. Only an approved template can go out now. If the
 * channel has a fallback template, send it (the customer gets the template, not
 * the AI text, and the message says so); otherwise fail with a clear reason.
 */
async function outsideWindow(
  meta: ChannelMeta,
  input: SendInput,
  phoneNumberId: string,
  accessToken: string,
  status: number,
  body: string
): Promise<SendResult> {
  const tpl = fallbackTemplate(meta);
  if (tpl) {
    const res = await fetchWithRetry(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: input.to,
        type: 'template',
        template: { name: tpl.name, language: { code: tpl.language } },
      }),
    });
    const tbody = await res.text().catch(() => '');
    if (res.ok) {
      return {
        attempted: true,
        ok: true,
        status: res.status,
        messageId: wamidFromResponse(tbody),
        message: `24-hour window closed: sent approved template "${tpl.name}" to ${input.to} instead of the reply`,
        body: tbody.slice(0, 500),
        code: 'outside_window',
      };
    }
    return {
      attempted: true,
      ok: false,
      status: res.status,
      messageId: null,
      message: `24-hour window closed and the fallback template failed: ${tbody.slice(0, 200)}`,
      body: tbody.slice(0, 500),
      code: 'outside_window',
    };
  }
  return {
    attempted: true,
    ok: false,
    status,
    messageId: null,
    message:
      'Outside the 24-hour reply window: WhatsApp only allows an approved template now. Add a fallback template in Auto-reply settings.',
    body: body.slice(0, 500),
    code: 'outside_window',
  };
}
