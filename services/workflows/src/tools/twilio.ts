import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import {
  apiError,
  confirmFromRisk,
  fetchWithTimeout,
  isProviderUnauthorized,
  notConnected,
  resolveNangoAuth,
  revoked,
  withOrgScopedClient,
} from './shared.js';

const ACTIONS = ['send_sms', 'list_messages'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('fetch') || a.includes('read')) return 'read';
  return 'send';
}

interface TwilioCreds {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  source: 'nango' | 'channel' | 'env';
}

async function twilioCreds(orgId: string): Promise<TwilioCreds | { kind: 'never-configured' } | { kind: 'revoked'; detail: string }> {
  const nango = await resolveNangoAuth(`${orgId}_twilio`, ['twilio']);
  if (nango.kind === 'revoked') return nango;
  if (nango.kind === 'connected') {
    const creds = (nango.connection.credentials || {}) as Record<string, any>;
    const raw = (creds.raw || {}) as Record<string, any>;
    const cfg = (nango.connection.connection_config || nango.connection.metadata || {}) as Record<string, any>;
    const accountSid = String(creds.username || creds.apiKey || raw.account_sid || cfg.accountSid || '');
    const authToken = String(creds.password || creds.apiSecret || nango.accessToken || raw.auth_token || '');
    const fromNumber = String(cfg.fromNumber || cfg.phoneNumber || raw.from || process.env.TWILIO_FROM_NUMBER || '');
    if (accountSid && authToken) return { accountSid, authToken, fromNumber, source: 'nango' };
  }

  let meta: Record<string, any> = {};
  await withOrgScopedClient(orgId, async (client) => {
    const chan = await client.query(
      `SELECT meta FROM channels WHERE org_id = $1 AND channel_type = 'twilio' AND status IN ('connected', 'active')`,
      [orgId],
    );
    meta = chan.rows[0]?.meta || {};
  });
  const fromChannel: TwilioCreds = {
    accountSid: String(meta.accountSid || meta.account_sid || ''),
    authToken: String(meta.authToken || meta.auth_token || ''),
    fromNumber: String(meta.fromNumber || meta.from_number || meta.phoneNumber || ''),
    source: 'channel',
  };
  if (fromChannel.accountSid && fromChannel.authToken) return fromChannel;

  const fromEnv: TwilioCreds = {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    source: 'env',
  };
  if (fromEnv.accountSid && fromEnv.authToken) return fromEnv;
  return { kind: 'never-configured' };
}

function basicAuth(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const creds = await twilioCreds(orgId);
  if ('kind' in creds && creds.kind === 'never-configured') return notConnected('twilio', actionName, timestamp);
  if ('kind' in creds && creds.kind === 'revoked') return revoked('twilio', actionName, timestamp, creds.detail);

  const { accountSid, authToken, fromNumber } = creds;
  const headers = {
    Authorization: basicAuth(accountSid, authToken),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const apiBase = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;

  try {
    if (actionName.includes('list') || actionName.includes('fetch') || actionName.includes('read')) {
      const res = await fetchWithTimeout(`${apiBase}/Messages.json?PageSize=${Math.min(Number(payload.count) || 10, 50)}`, {
        headers: { Authorization: headers.Authorization },
      });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('twilio', 'list_messages', timestamp, `Twilio HTTP ${res.status}`);
      if (!res.ok) return apiError('twilio', 'list_messages', timestamp, `Twilio list failed: HTTP ${res.status}`, data);
      const messages = Array.isArray(data.messages) ? data.messages : [];
      return {
        tool: 'twilio',
        action: 'list_messages',
        status: 'executed' as const,
        message: `Fetched ${messages.length} Twilio messages`,
        data: {
          messages: messages.map((m: any) => ({
            sid: m.sid,
            to: m.to,
            from: m.from,
            body: m.body,
            status: m.status,
            dateSent: m.date_sent,
          })),
          httpStatus: res.status,
          connected: true,
        },
        timestamp,
      };
    }

    const to = payload.to || payload.phone || payload.recipient;
    const body = payload.body || payload.message || payload.text;
    const from = payload.from || fromNumber;
    if (!to) return apiError('twilio', 'send_sms', timestamp, 'Recipient phone (to) is required.');
    if (!body) return apiError('twilio', 'send_sms', timestamp, 'Message body is required.');
    if (!from) return apiError('twilio', 'send_sms', timestamp, 'From number is required (payload.from, channel meta, or TWILIO_FROM_NUMBER).');
    const res = await fetchWithTimeout(`${apiBase}/Messages.json`, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ To: String(to), From: String(from), Body: String(body) }),
    });
    const data = await res.json().catch(() => ({}));
    if (isProviderUnauthorized(res.status)) return revoked('twilio', 'send_sms', timestamp, `Twilio HTTP ${res.status}`);
    if (!res.ok) return apiError('twilio', 'send_sms', timestamp, `Twilio send failed: HTTP ${res.status} ${data?.message || ''}`.trim(), data);
    return {
      tool: 'twilio',
      action: 'send_sms',
      status: 'executed' as const,
      message: `Sent SMS to ${to} via Twilio`,
      data: { sid: data.sid, to: data.to, from: data.from, status: data.status, httpStatus: res.status, connected: true },
      timestamp,
    };
  } catch (e: any) {
    return apiError('twilio', actionName, timestamp, `Twilio API error: ${e.message}`);
  }
}

export const twilio: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
