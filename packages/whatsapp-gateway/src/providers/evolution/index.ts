import { fetchWithRetry, fetchWithTimeout, metaString } from '../../http.js';
import type { ChannelMeta, SendInput, SendResult, WhatsAppProvider } from '../../types.js';

/**
 * Evolution API (https://github.com/EvolutionAPI/evolution-api, Apache-2.0 with
 * an attribution condition — the dashboard shows "Powered by Evolution API").
 * We use its WhatsApp-Web (Baileys) engine for QR pairing. One instance per org.
 * Server config comes from env: EVOLUTION_API_URL, EVOLUTION_API_KEY.
 */

export const WEBHOOK_SECRET_HEADER = 'x-darex-webhook-secret';
const WEBHOOK_EVENTS = ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE'];

function server() {
  return {
    url: (process.env.EVOLUTION_API_URL || '').replace(/\/$/, ''),
    key: process.env.EVOLUTION_API_KEY || '',
  };
}

export function evolutionConfigured(): boolean {
  const s = server();
  return Boolean(s.url && s.key);
}

/**
 * Stable per-number instance name (also the value we resolve inbound webhooks
 * by). The org's first number has no key; extra numbers add `-<accountKey>`.
 */
export function evolutionInstanceName(orgId: string, accountKey = ''): string {
  return `darex-${orgId.replace(/-/g, '')}${accountKey ? `-${accountKey}` : ''}`;
}

type Call = { ok: boolean; status: number; json: any; text: string };

/** Pairing calls create a WhatsApp session and can be slow on a busy host, so they get a longer timeout. */
const SLOW_MS = 45000;

async function call(path: string, method: string, body?: unknown, retry = false, timeoutMs = 15000): Promise<Call> {
  const s = server();
  if (!s.url || !s.key) {
    return { ok: false, status: 0, json: null, text: 'EVOLUTION_API_URL / EVOLUTION_API_KEY not set' };
  }
  const init: RequestInit = {
    method,
    headers: { apikey: s.key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  try {
    const res = retry ? await fetchWithRetry(s.url + path, init, timeoutMs) : await fetchWithTimeout(s.url + path, init, timeoutMs);
    const text = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body: keep text */
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err: unknown) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
    return {
      ok: false,
      status: 0,
      json: null,
      text: aborted ? 'the WhatsApp gateway did not answer in time, try again' : err instanceof Error ? err.message : String(err),
    };
  }
}

function errorText(c: Call): string {
  const m = c.json?.response?.message ?? c.json?.message ?? c.json?.error;
  const s = Array.isArray(m) ? m.join(', ') : typeof m === 'string' ? m : c.text;
  return String(s || `HTTP ${c.status}`).slice(0, 200);
}

export type EvolutionQr = { qrBase64: string | null; pairingCode: string | null };

function qrFrom(json: any): EvolutionQr {
  const q = json?.qrcode ?? json;
  const b64 = typeof q?.base64 === 'string' && q.base64 ? q.base64 : null;
  return {
    qrBase64: b64 && !b64.startsWith('data:') ? `data:image/png;base64,${b64}` : b64,
    pairingCode: typeof q?.pairingCode === 'string' && q.pairingCode ? q.pairingCode : null,
  };
}

async function setWebhook(instance: string, url: string, secret: string): Promise<Call> {
  return call(`/webhook/set/${encodeURIComponent(instance)}`, 'POST', {
    webhook: {
      enabled: true,
      url,
      byEvents: false,
      base64: true, // media arrives inline (we do not store messages in Evolution)
      headers: { [WEBHOOK_SECRET_HEADER]: secret },
      events: WEBHOOK_EVENTS,
    },
  }, false, SLOW_MS);
}

/**
 * Create the org's instance (or reuse it), point its webhook at us, and return
 * the QR to scan. Safe to call again to get a fresh QR.
 */
export async function startEvolutionPairing(input: {
  instance: string;
  webhookUrl: string;
  webhookSecret: string;
}): Promise<{ ok: boolean; status: number; message: string } & EvolutionQr> {
  const empty: EvolutionQr = { qrBase64: null, pairingCode: null };
  const created = await call('/instance/create', 'POST', {
    instanceName: input.instance,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    syncFullHistory: false,
    webhook: {
      enabled: true,
      url: input.webhookUrl,
      byEvents: false,
      base64: true, // media arrives inline (we do not store messages in Evolution)
      headers: { [WEBHOOK_SECRET_HEADER]: input.webhookSecret },
      events: WEBHOOK_EVENTS,
    },
  }, false, SLOW_MS);
  if (created.ok) return { ok: true, status: created.status, message: 'Scan the QR with WhatsApp.', ...qrFrom(created.json) };

  // 403 = "instance name already in use": reuse it, refresh webhook, ask for a QR.
  if (created.status !== 403 && created.status !== 409) {
    return { ok: false, status: created.status, message: `Evolution create failed: ${errorText(created)}`, ...empty };
  }
  const hook = await setWebhook(input.instance, input.webhookUrl, input.webhookSecret);
  if (!hook.ok) {
    return { ok: false, status: hook.status, message: `Evolution webhook set failed: ${errorText(hook)}`, ...empty };
  }
  const connect = await call(`/instance/connect/${encodeURIComponent(input.instance)}`, 'GET', undefined, false, SLOW_MS);
  if (!connect.ok) {
    return { ok: false, status: connect.status, message: `Evolution connect failed: ${errorText(connect)}`, ...empty };
  }
  return { ok: true, status: connect.status, message: 'Scan the QR with WhatsApp.', ...qrFrom(connect.json) };
}

export type EvolutionState = 'open' | 'connecting' | 'close' | 'missing' | 'error';

export async function getEvolutionState(instance: string): Promise<{ state: EvolutionState; message: string }> {
  const r = await call(`/instance/connectionState/${encodeURIComponent(instance)}`, 'GET');
  if (r.status === 404) return { state: 'missing', message: 'Instance not found' };
  if (!r.ok) return { state: 'error', message: errorText(r) };
  const state = r.json?.instance?.state;
  return {
    state: state === 'open' || state === 'connecting' || state === 'close' ? state : 'close',
    message: String(state ?? 'close'),
  };
}

/** The linked phone number and profile name once the instance is open (null while unlinked or on any error). */
export async function getEvolutionOwner(instance: string): Promise<{ phone: string | null; profileName: string | null }> {
  const r = await call(`/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`, 'GET');
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  const jid = row?.ownerJid ?? row?.instance?.owner;
  const phone = typeof jid === 'string' && jid.includes('@') ? jid.split('@')[0].split(':')[0] : null;
  const name = row?.profileName ?? row?.instance?.profileName;
  return { phone: phone && /^\d{6,20}$/.test(phone) ? phone : null, profileName: typeof name === 'string' && name ? name : null };
}

/** Fresh QR for an existing, not-yet-open instance. */
export async function getEvolutionQr(instance: string): Promise<EvolutionQr & { ok: boolean; message: string }> {
  const r = await call(`/instance/connect/${encodeURIComponent(instance)}`, 'GET', undefined, false, SLOW_MS);
  return { ok: r.ok, message: r.ok ? 'ok' : errorText(r), ...qrFrom(r.ok ? r.json : null) };
}

/** Unlink the phone and remove the instance. A missing instance counts as done. */
export async function stopEvolutionInstance(instance: string): Promise<{ ok: boolean; message: string }> {
  await call(`/instance/logout/${encodeURIComponent(instance)}`, 'DELETE');
  const del = await call(`/instance/delete/${encodeURIComponent(instance)}`, 'DELETE');
  if (del.ok || del.status === 404) return { ok: true, message: 'Disconnected' };
  return { ok: false, message: `Evolution delete failed: ${errorText(del)}` };
}

export const evolution: WhatsAppProvider = {
  id: 'evolution',
  label: 'WhatsApp Web (scan QR)',

  canSend(meta) {
    return Boolean(metaString(meta, 'evolution_instance')) && evolutionConfigured();
  },

  async send(meta: ChannelMeta, input: SendInput): Promise<SendResult> {
    const instance = metaString(meta, 'evolution_instance');
    if (!instance || !evolutionConfigured()) {
      return {
        attempted: false,
        ok: false,
        status: 0,
        messageId: null,
        message: 'WhatsApp (QR) not connected - scan the QR at /connectors.',
        body: '',
      };
    }
    const r = await call(`/message/sendText/${encodeURIComponent(instance)}`, 'POST', {
      number: input.to,
      text: input.text,
    }, true);
    const id = r.json?.key?.id;
    return {
      attempted: true,
      ok: r.ok,
      status: r.status,
      messageId: r.ok && typeof id === 'string' && id ? id : null,
      message: r.ok ? `AI reply to ${input.to}` : `Evolution send failed: ${errorText(r)}`,
      body: r.text.slice(0, 500),
    };
  },
};

export { parseEvolutionWebhook } from './webhook.js';
