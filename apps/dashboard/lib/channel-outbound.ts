import { getOrgScopedClient } from '@/lib/db';
import { getNangoConnection } from '@/lib/nango-server';
import { maskRecipient, recordFailedWebhook } from '@/lib/failed-webhooks';
import { sendWhatsApp as sendWhatsAppViaGateway, wamidFromResponse } from '@darex/whatsapp-gateway';
import { parseAutoReply } from '@/lib/whatsapp-auto-reply-config';

export type ChannelReplyTarget = {
  channelType: string;
  contactId: string;
  phoneNumberId?: string | null;
  metaAccessToken?: string | null;
  /** Provider routing keys from WhatsApp channel meta (`provider`, `evolution_instance`). */
  whatsappMeta?: Record<string, unknown> | null;
  chatwootAccountId?: string | number | null;
  chatwootConvId?: string | number | null;
  chatwootBaseUrl?: string | null;
  chatwootApiToken?: string | null;
  /** Gmail thread to reply into (optional). */
  gmailThreadId?: string | null;
  /** Reply subject; defaults to a generic Re: line. */
  gmailSubject?: string | null;
  /** Twilio / SMS from-number and credentials (channel meta or env). */
  twilioAccountSid?: string | null;
  twilioAuthToken?: string | null;
  twilioFromNumber?: string | null;
  /** Instagram Graph page / IG user id used as the send path. */
  instagramAccountId?: string | null;
};

export type OutboundResult = {
  attempted: boolean;
  sent: boolean;
  statusCode: number;
  message: string;
  body: string;
  /** Provider message id (WhatsApp wamid) so delivery receipts can match the row. */
  providerMessageId?: string | null;
};

/** WhatsApp Cloud API send response: `{ messages: [{ id: "wamid..." }] }`. */
export const whatsappMessageIdFromResponse = wamidFromResponse;

type OutboundKind =
  | 'whatsapp'
  | 'chatwoot'
  | 'gmail'
  | 'email'
  | 'sms'
  | 'instagram'
  | 'dashboard'
  | 'unsupported';

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
    case 'sms':
    case 'twilio':
      return 'sms';
    case 'instagram':
    case 'ig':
      return 'instagram';
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
  extras?: { chatwootConvId?: string | number | null; gmailThreadId?: string | null; gmailSubject?: string | null }
): ChannelReplyTarget {
  return {
    channelType,
    contactId,
    whatsappMeta:
      channelType === 'whatsapp'
        ? {
            provider: channelMetaString(meta, 'provider'),
            evolution_instance: channelMetaString(meta, 'evolution_instance'),
            fallback_template: parseAutoReply(meta?.auto_reply).fallbackTemplate,
          }
        : null,
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
    gmailThreadId: extras?.gmailThreadId ?? channelMetaString(meta, 'thread_id', 'threadId', 'gmail_thread_id'),
    gmailSubject: extras?.gmailSubject ?? channelMetaString(meta, 'subject', 'gmail_subject'),
    twilioAccountSid:
      channelMetaString(meta, 'account_sid', 'accountSid') || process.env.TWILIO_ACCOUNT_SID || null,
    twilioAuthToken:
      channelMetaString(meta, 'auth_token', 'authToken') || process.env.TWILIO_AUTH_TOKEN || null,
    twilioFromNumber:
      channelMetaString(meta, 'from_number', 'fromNumber', 'phone', 'phoneNumber') ||
      process.env.TWILIO_FROM_NUMBER ||
      null,
    instagramAccountId:
      channelMetaString(meta, 'ig_user_id', 'instagram_account_id', 'page_id', 'pageId') || null,
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

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  attempts = 3
): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetchWithTimeout(url, init, timeoutMs);
    if (last.ok || (last.status < 500 && last.status !== 429)) return last;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)));
    }
  }
  return last!;
}

function notConnected(message: string): OutboundResult {
  return { attempted: false, sent: false, statusCode: 0, message, body: '' };
}

async function sendWhatsApp(target: ChannelReplyTarget, text: string): Promise<OutboundResult> {
  // Provider (Meta Cloud vs QR) comes from channel meta; env fills Meta's gaps.
  const r = await sendWhatsAppViaGateway(
    {
      ...(target.whatsappMeta || {}),
      phone_number_id: target.phoneNumberId,
      meta_access_token: target.metaAccessToken,
    },
    { to: target.contactId, text }
  );
  return {
    attempted: r.attempted,
    sent: r.ok,
    statusCode: r.status,
    message: r.message,
    body: r.body,
    providerMessageId: r.messageId,
  };
}

async function sendChatwoot(target: ChannelReplyTarget, text: string): Promise<OutboundResult> {
  const base = (target.chatwootBaseUrl || '').replace(/\/$/, '');
  const token = target.chatwootApiToken;
  const accountId = target.chatwootAccountId;
  const convId = target.chatwootConvId;
  if (!base || !token || accountId == null || convId == null) {
    return notConnected(
      'Chatwoot outbound not configured - set CHATWOOT_BASE_URL, CHATWOOT_API_ACCESS_TOKEN, CHATWOOT_ACCOUNT_ID (or channel meta).'
    );
  }
  try {
    const res = await fetchWithRetry(
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

async function gmailAccessToken(orgId: string): Promise<string | null> {
  const conn = await getNangoConnection(orgId, 'gmail');
  const token =
    conn?.credentials?.raw?.access_token || conn?.credentials?.access_token || null;
  return typeof token === 'string' && token ? token : null;
}

function encodeGmailRaw(to: string, subject: string, body: string, threadHeaders?: { inReplyTo?: string | null }): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (threadHeaders?.inReplyTo) {
    lines.push(`In-Reply-To: ${threadHeaders.inReplyTo}`);
    lines.push(`References: ${threadHeaders.inReplyTo}`);
  }
  lines.push('', body);
  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendGmail(orgId: string, target: ChannelReplyTarget, text: string): Promise<OutboundResult> {
  const to = (target.contactId || '').trim();
  if (!to || !to.includes('@')) {
    return notConnected('Gmail reply requires an email address as contact_id.');
  }
  const token = await gmailAccessToken(orgId);
  if (!token) {
    return notConnected('Gmail not connected - authorize Google Mail at /connectors.');
  }
  const subject = (target.gmailSubject || '').trim() || 'Re: Your message';
  try {
    const payload: Record<string, string> = {
      raw: encodeGmailRaw(to, subject, text),
    };
    if (target.gmailThreadId) {
      payload.threadId = target.gmailThreadId;
    }
    const res = await fetchWithRetry(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      15000
    );
    const body = await res.text().catch(() => '');
    return {
      attempted: true,
      sent: res.ok,
      statusCode: res.status,
      message: res.ok ? `Gmail reply to ${to}` : `Gmail send failed: ${body.slice(0, 200)}`,
      body: body.slice(0, 500),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      attempted: true,
      sent: false,
      statusCode: 0,
      message: `Gmail send error: ${message}`,
      body: '',
    };
  }
}

async function resolveTwilioCreds(
  orgId: string,
  target: ChannelReplyTarget
): Promise<{ accountSid: string; authToken: string; fromNumber: string } | null> {
  let accountSid = target.twilioAccountSid || '';
  let authToken = target.twilioAuthToken || '';
  let fromNumber = target.twilioFromNumber || '';

  if (accountSid && authToken && fromNumber) {
    return { accountSid, authToken, fromNumber };
  }

  const { client } = await getOrgScopedClient(orgId);
  try {
    const chan = await client.query(
      `SELECT meta FROM channels
        WHERE org_id = $1 AND channel_type IN ('sms', 'twilio')
          AND status IN ('connected', 'active')
        ORDER BY connected_at DESC NULLS LAST
        LIMIT 1`,
      [orgId]
    );
    const meta = (chan.rows[0]?.meta || {}) as Record<string, unknown>;
    accountSid =
      accountSid ||
      channelMetaString(meta, 'account_sid', 'accountSid') ||
      process.env.TWILIO_ACCOUNT_SID ||
      '';
    authToken =
      authToken ||
      channelMetaString(meta, 'auth_token', 'authToken') ||
      process.env.TWILIO_AUTH_TOKEN ||
      '';
    fromNumber =
      fromNumber ||
      channelMetaString(meta, 'from_number', 'fromNumber', 'phone', 'phoneNumber') ||
      process.env.TWILIO_FROM_NUMBER ||
      '';
  } finally {
    client.release();
  }

  if (!accountSid || !authToken) return null;
  return { accountSid, authToken, fromNumber };
}

async function sendSms(orgId: string, target: ChannelReplyTarget, text: string): Promise<OutboundResult> {
  const to = (target.contactId || '').trim();
  if (!to) {
    return notConnected('SMS reply requires a phone number as contact_id.');
  }
  const creds = await resolveTwilioCreds(orgId, target);
  if (!creds) {
    return notConnected(
      'SMS/Twilio not connected - configure channel meta or TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN at /connectors.'
    );
  }
  if (!creds.fromNumber) {
    return notConnected('SMS from-number missing - set channel meta from_number or TWILIO_FROM_NUMBER.');
  }
  try {
    const apiBase = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}`;
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
    const res = await fetchWithRetry(
      `${apiBase}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: creds.fromNumber, Body: text }),
      },
      15000
    );
    const body = await res.text().catch(() => '');
    return {
      attempted: true,
      sent: res.ok,
      statusCode: res.status,
      message: res.ok ? `SMS reply to ${to}` : `Twilio SMS send failed: ${body.slice(0, 200)}`,
      body: body.slice(0, 500),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      attempted: true,
      sent: false,
      statusCode: 0,
      message: `Twilio SMS send error: ${message}`,
      body: '',
    };
  }
}

async function sendInstagram(orgId: string, target: ChannelReplyTarget, text: string): Promise<OutboundResult> {
  const recipientId = (target.contactId || '').trim();
  if (!recipientId) {
    return notConnected('Instagram reply requires a recipient IGSID as contact_id.');
  }

  let accessToken = target.metaAccessToken || '';
  let pageId = target.instagramAccountId || '';

  if (!accessToken || !pageId) {
    const { client } = await getOrgScopedClient(orgId);
    try {
      const chan = await client.query(
        `SELECT meta FROM channels
          WHERE org_id = $1 AND channel_type = 'instagram'
            AND status IN ('connected', 'active')
          ORDER BY connected_at DESC NULLS LAST
          LIMIT 1`,
        [orgId]
      );
      const meta = (chan.rows[0]?.meta || {}) as Record<string, unknown>;
      accessToken =
        accessToken ||
        channelMetaString(meta, 'meta_access_token', 'accessToken', 'page_access_token') ||
        process.env.META_ACCESS_TOKEN ||
        '';
      pageId =
        pageId ||
        channelMetaString(meta, 'ig_user_id', 'instagram_account_id', 'page_id', 'pageId') ||
        '';
    } finally {
      client.release();
    }
  }

  if (!accessToken) {
    return notConnected(
      'Instagram not connected - missing Meta page access token. Connect Instagram at /connectors.'
    );
  }
  if (!pageId) {
    return notConnected(
      'Instagram account id missing - set channel meta ig_user_id / page_id before sending DMs.'
    );
  }

  // Meta 24-hour messaging window: only send if customer messaged within last 24h.
  {
    const { client } = await getOrgScopedClient(orgId);
    try {
      const recent = await client.query(
        `SELECT 1 FROM messages m
           JOIN conversations c ON c.id = m.conversation_id AND c.org_id = m.org_id
          WHERE m.org_id = $1
            AND c.contact_id = $2
            AND m.role IN ('user', 'customer')
            AND m.created_at > NOW() - INTERVAL '24 hours'
          LIMIT 1`,
        [orgId, recipientId]
      );
      if (recent.rows.length === 0) {
        return {
          attempted: false,
          sent: false,
          statusCode: 0,
          message:
            'Instagram 24-hour messaging window closed - customer has not messaged in the last 24 hours.',
          body: '',
        };
      }
    } finally {
      client.release();
    }
  }

  try {
    const res = await fetchWithRetry(
      `https://graph.facebook.com/v18.0/${encodeURIComponent(pageId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text },
        }),
      },
      15000
    );
    const body = await res.text().catch(() => '');
    return {
      attempted: true,
      sent: res.ok,
      statusCode: res.status,
      message: res.ok
        ? `Instagram reply to ${recipientId}`
        : `Instagram Graph send failed: ${body.slice(0, 200)}`,
      body: body.slice(0, 500),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      attempted: true,
      sent: false,
      statusCode: 0,
      message: `Instagram send error: ${message}`,
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
    return { attempted: false, sent: false, statusCode: 0, message: 'Empty reply - not sent', body: '' };
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
      result = await sendGmail(orgId, target, trimmed);
      break;
    case 'sms':
      result = await sendSms(orgId, target, trimmed);
      break;
    case 'instagram':
      result = await sendInstagram(orgId, target, trimmed);
      break;
    case 'dashboard':
      result = {
        attempted: false,
        sent: false,
        statusCode: 0,
        message: 'Dashboard inbox thread - no external send',
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
  if (result.attempted && !result.sent) {
    // No full recipient or message text in the DLQ; the org-scoped channel_logs row has the detail.
    await recordFailedWebhook({
      orgId,
      channel: `outbound:${kind}`,
      rawPayload: JSON.stringify({
        to: maskRecipient(target.contactId),
        length: trimmed.length,
        statusCode: result.statusCode,
      }),
      errorMessage: result.message.split(target.contactId || '\u0000').join(maskRecipient(target.contactId)),
    });
  }
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
