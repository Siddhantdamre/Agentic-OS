/**
 * Read-only connection diagnostics for /api/integrations/test and BYOK verify.
 * Callers: apps/dashboard/app/api/integrations/test/route.ts,
 * apps/dashboard/app/api/integrations/whatsapp/route.ts,
 * apps/dashboard/app/api/integrations/razorpay/route.ts.
 * No existing test-connection.ts (glob of services/connectors/src confirmed).
 * Does not persist files. Runtime HTTP only.
 */

import { NangoConnectorClient } from './client';
import { NANGO_PING_SPECS } from './providers';
import { ConnectionPingResult, RazorpayCredentials, WhatsAppCredentials } from './types';

function pingFail(provider: string, status: number, message: string, data?: unknown): ConnectionPingResult {
  return { connected: false, provider, ok: false, status, message, data };
}

function pingOk(provider: string, status: number, message: string, data?: unknown): ConnectionPingResult {
  return { connected: true, provider, ok: true, status, message, data };
}

/**
 * Read-only connection diagnostic via Nango proxy. Does not send mail, messages, or create records.
 */
export async function pingNangoProvider(
  client: NangoConnectorClient,
  orgId: string,
  provider: string,
  extra?: { developerToken?: string }
): Promise<ConnectionPingResult> {
  if (!client.isConfigured()) {
    return pingFail(provider, 503, 'NANGO_SECRET_KEY is not set on the server');
  }

  const live = await client.resolveLiveConnection(orgId, provider);
  if (!live) {
    return pingFail(
      provider,
      404,
      `No Nango OAuth connection for ${provider}. Complete OAuth at /connectors.`,
      { setupUrl: '/connectors' }
    );
  }

  const spec = NANGO_PING_SPECS[provider];
  if (!spec) {
    return pingOk(
      provider,
      200,
      `Nango connection exists for ${provider} (${live.connectionId}). No read-only ping endpoint is registered; tokens were not fetched into this app.`,
      { connectionId: live.connectionId, providerConfigKey: live.providerConfigKey }
    );
  }

  const headers: Record<string, string> = { ...(spec.headers || {}) };
  if (provider === 'google-ads') {
    const token = extra?.developerToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    if (!token) {
      return pingFail(
        provider,
        400,
        'Nango is connected, but GOOGLE_ADS_DEVELOPER_TOKEN is not set. Paste a developer token in dashboard env to ping the Ads API.',
        { connectionId: live.connectionId, missing: 'GOOGLE_ADS_DEVELOPER_TOKEN' }
      );
    }
    headers['developer-token'] = token;
  }

  try {
    const data = await client.proxyRequest(
      orgId,
      provider,
      spec.endpoint,
      spec.method,
      spec.data,
      Object.keys(headers).length ? headers : undefined
    );
    return pingOk(provider, 200, `${provider} connection ping succeeded`, data);
  } catch (err: any) {
    const status = err.status || err.response?.status || 502;
    return pingFail(
      provider,
      status,
      err.message || `${provider} ping failed`,
      err.response?.data || err.data
    );
  }
}

export async function pingWhatsApp(creds: WhatsAppCredentials): Promise<ConnectionPingResult> {
  const { accessToken, phoneNumberId } = creds;
  if (!accessToken || !phoneNumberId) {
    return pingFail('whatsapp', 400, 'WhatsApp access token and phone number ID are required');
  }
  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return pingFail(
        'whatsapp',
        res.status,
        data?.error?.message || `Meta Graph rejected the token (HTTP ${res.status}). Rotate META / system-user token.`,
        data
      );
    }
    return pingOk('whatsapp', 200, 'WhatsApp Business phone number is reachable', data);
  } catch (err: any) {
    return pingFail('whatsapp', 502, err.message || 'Meta Graph request failed');
  }
}

export async function pingRazorpay(creds: RazorpayCredentials): Promise<ConnectionPingResult> {
  const { keyId, keySecret } = creds;
  if (!keyId || !keySecret) {
    return pingFail(
      'razorpay',
      400,
      'Razorpay key_id and key_secret are required (per-org keys or RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env)'
    );
  }
  try {
    const basic = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/payments?count=1', {
      headers: { Authorization: `Basic ${basic}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return pingFail('razorpay', res.status, data?.error?.description || `Razorpay HTTP ${res.status}`, data);
    }
    return pingOk('razorpay', 200, 'Razorpay API keys are valid', { count: data?.count ?? 0 });
  } catch (err: any) {
    return pingFail('razorpay', 502, err.message || 'Razorpay request failed');
  }
}

export async function sendWhatsAppWithCreds(
  creds: WhatsAppCredentials,
  payload: { recipient: string; text: string }
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`https://graph.facebook.com/v18.0/${encodeURIComponent(creds.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: payload.recipient,
      type: 'text',
      text: { body: payload.text },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function createRazorpayInvoiceWithCreds(
  creds: RazorpayCredentials,
  payload: { customerEmail: string; amountInPaisa: number; description: string }
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const basic = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/invoices', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'invoice',
      description: payload.description,
      customer: { email: payload.customerEmail },
      line_items: [
        {
          amount: payload.amountInPaisa,
          currency: 'INR',
          name: payload.description,
          quantity: 1,
        },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
