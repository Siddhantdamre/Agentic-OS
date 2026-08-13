import { getOrgScopedClient } from '@/lib/db';

export type ChannelReplyTarget = {
  channelType: string;
  contactId: string;
  phoneNumberId?: string | null;
  metaAccessToken?: string | null;
  chatwootAccountId?: string | number | null;
  chatwootConvId?: string | number | null;
  chatwootBaseUrl?: string | null;
  chatwootApiToken?: string | null;
};

export type OutboundResult = {
  attempted: boolean;
  sent: boolean;
  statusCode: number;
  message: string;
  body: string;
};

type OutboundKind = 'whatsapp' | 'chatwoot' | 'gmail' | 'email' | 'dashboard' | 'unsupported';

function normalizeOutboundKind(channelType: string | null | undefined): OutboundKind {
  switch ((channelType || '').toLowerCase()) {
    case 'whatsapp':
      return 'whatsapp';
    case 'chatwoot':
      return 'chatwoot';
    case 'gmail':
      return 'gmail';
    case 'email':
      return 'email';
    case 'dashboard':
    case '':
    case 'inbox':
      return 'dashboard';
    default:
      return 'unsupported';
  }
}

function channelMetaString(meta: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!meta) return null;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function replyTargetFromChannelMeta(
  channelType: string,
  contactId: string,
  meta: Record<string, unknown> | null | undefined,
  extras?: { chatwootConvId?: string | number | null }
): ChannelReplyTarget {
  return {
    channelType,
    contactId,
    phoneNumberId:
      channelMetaString(meta, 'phone_number_id', 'phoneNumberId') || process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    metaAccessToken:
      channelMetaString(meta, 'meta_access_token', 'accessToken') || process.env.META_ACCESS_TOKEN || null,
    chatwootAccountId: channelMetaString(meta, 'chatwoot_account_id', 'account_id') || process.env.CHATWOOT_ACCOUNT_ID || null,
    chatwootConvId: extras?.chatwootConvId ?? null,
    chatwootBaseUrl: channelMetaString(meta, 'chatwoot_base_url', 'base_url') || process.env.CHATWOOT_BASE_URL || null,
    chatwootApiToken:
      channelMetaString(meta, 'chatwoot_api_access_token', 'api_access_token') ||
      process.env.CHATWOOT_API_ACCESS_TOKEN ||
      null,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendWhatsApp(target: ChannelReplyTarget, text: string): Promise<OutboundResult> {
  if (!target.phoneNumberId || !target.metaAccessToken) {
    return {
      attempted: true,
      sent: false,
      statusCode: 0,
      message: 'WhatsApp not connected — missing phone_number_id or access token. Connect at /connectors.',
      body: '',
    };
  }
  try {
    const res = await fetchWithTimeout(
      `https://graph.facebook.com/v18.0/${target.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.metaAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: target.contactId,
          type: 'text',
          text: { body: text },
        }),
      },
      15000
    );
    const body = await res.text().catch(() => '');
    return {
      attempted: true,
      sent: res.ok,
      statusCode: res.status,
      message: res.ok ? `AI reply to ${target.contactId}` : `Meta Graph send failed: ${body.slice(0, 200)}`,
      body: body.slice(0, 500),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      attempted: true,
      sent: false,
      statusCode: 0,
      message: `Meta Graph send error: ${message}`,
      body: '',
    };
  }
}

async function sendChatwoot(target: ChannelReplyTarget, text: string): Promise<OutboundResult> {
  const base = (target.chatwootBaseUrl || '').replace(/\/$/, '');
  const token = target.chatwootApiToken;
  const accountId = target.chatwootAccountId;
  const convId = target.chatwootConvId;
  if (!base || !token || accountId == null || convId == null) {
    return {
      attempted: true,
      sent: false,
      statusCode: 0,
      message:
        'Chatwoot outbound not configured — set CHATWOOT_BASE_URL, CHATWOOT_API_ACCESS_TOKEN, CHATWOOT_ACCOUNT_ID (or channel meta).',
      body: '',
    };
  }
  try {
    const res = await fetchWithTimeout(
      `${base}/api/v1/accounts/${accountId}/conversations/${convId}/messages`,
      {
        method: 'POST',
        headers: {
          api_access_token: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: text, message_type: 'outgoing', private: false }),
      },
      15000
    );
    const body = await res.text().catch(() => '');
    return {
      attempted: true,
      sent: res.ok,
      statusCode: res.status,
      message: res.ok ? `Chatwoot reply to conversation ${convId}` : `Chatwoot send failed: ${body.slice(0, 200)}`,
      body: body.slice(0, 500),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      attempted: true,
      sent: false,
      statusCode: 0,
      message: `Chatwoot send error: ${message}`,
      body: '',
    };
  }
}

export async function sendChannelReply(
  orgId: string,
  target: ChannelReplyTarget,
  text: string
): Promise<OutboundResult> {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return { attempted: false, sent: false, statusCode: 0, message: 'Empty reply — not sent', body: '' };
  }

  const kind = normalizeOutboundKind(target.channelType);
  let result: OutboundResult;
  switch (kind) {
    case 'whatsapp':
      result = await sendWhatsApp(target, trimmed);
      break;
    case 'chatwoot':
      result = await sendChatwoot(target, trimmed);
      break;
    case 'gmail':
    case 'email':
      result = {
        attempted: false,
        sent: false,
        statusCode: 0,
        message: 'Email channel has no webhook send-back path',
        body: '',
      };
      break;
    case 'dashboard':
      result = {
        attempted: false,
        sent: false,
        statusCode: 0,
        message: 'Dashboard inbox thread — no external send',
        body: '',
      };
      break;
    case 'unsupported':
      result = {
        attempted: false,
        sent: false,
        statusCode: 0,
        message: `No outbound sender for channel ${target.channelType}`,
        body: '',
      };
      break;
    default: {
      const _never: never = kind;
      result = { attempted: false, sent: false, statusCode: 0, message: String(_never), body: '' };
    }
  }

  await logOutbound(orgId, kind === 'unsupported' ? target.channelType || 'unknown' : kind, result, target, trimmed);
  return result;
}

async function logOutbound(
  orgId: string,
  channelType: string,
  result: OutboundResult,
  target: ChannelReplyTarget,
  text: string
): Promise<void> {
  if (!result.attempted) return;
  const { client } = await getOrgScopedClient(orgId);
  try {
    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, $2, 'outbound_message', $3, $4, $5, $6)`,
      [
        orgId,
        channelType,
        result.sent ? 'success' : 'error',
        result.statusCode || null,
        result.message.slice(0, 500),
        JSON.stringify({
          to: target.contactId,
          status: result.statusCode,
          body: result.body,
          preview: text.slice(0, 80),
        }),
      ]
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[channel-outbound] failed to log send:', message);
  } finally {
    client.release();
  }
}
