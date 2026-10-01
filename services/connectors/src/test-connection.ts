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
import {
  CONNECTORS_RECONNECT_URL,
  ConnectionPingResult,
  RazorpayCredentials,
  WhatsAppCredentials,
  notConnectedResult,
} from './types';

function pingFail(
  provider: string,
  status: number,
  message: string,
  data?: unknown,
  reconnect = true
): ConnectionPingResult {
  return {
    connected: false,
    provider,
    ok: false,
    status,
    message,
    data,
    reconnectUrl: reconnect ? CONNECTORS_RECONNECT_URL : undefined,
  };
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
    const honest = notConnectedResult(
      'not_connected',
      `No Nango OAuth connection for ${provider}. Complete OAuth at ${CONNECTORS_RECONNECT_URL}.`,
      provider
    );
    return pingFail(provider, 404, honest.message, {
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
      reason: honest.reason,
    });
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
    const reconnectUrl = err.reconnectUrl || CONNECTORS_RECONNECT_URL;
    return pingFail(
      provider,
      status,
      err.message || `${provider} ping failed`,
      {
        ...(typeof err.response?.data === 'object' ? err.response.data : {}),
        ...(typeof err.data === 'object' ? err.data : {}),
        reconnectUrl,
        setupUrl: reconnectUrl,
        reason: err.reason || (status === 401 || status === 403 ? 'expired' : undefined),
      }
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
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) }
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
      signal: AbortSignal.timeout(15_000),
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
    signal: AbortSignal.timeout(15_000),
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
    signal: AbortSignal.timeout(15_000),
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

export interface GoogleServiceDiagnostic {
  id: string;
  name: string;
  ok: boolean;
  status: number;
  message: string;
  data?: unknown;
  latencyMs?: number;
}

export interface GoogleWorkspaceSuiteResult {
  connected: boolean;
  ok: boolean;
  provider: 'google-workspace';
  accountEmail?: string;
  accountName?: string;
  message: string;
  services: GoogleServiceDiagnostic[];
  allPassed: boolean;
  passedCount: number;
  totalCount: number;
}

/**
 * Diagnostic test across all Google Workspace services under a single connection.
 */
export async function testGoogleWorkspace(
  client: NangoConnectorClient,
  orgId: string
): Promise<GoogleWorkspaceSuiteResult> {
  const live = await client.resolveLiveConnection(orgId, 'google');
  if (!live) {
    return {
      connected: false,
      ok: false,
      provider: 'google-workspace',
      message: 'Google Workspace is not connected. Click "Connect Google Workspace" to authorize all services at once.',
      services: [],
      allPassed: false,
      passedCount: 0,
      totalCount: 0,
    };
  }

  const workspaceTargets: Array<{ id: string; name: string }> = [
    { id: 'gmail', name: 'Gmail' },
    { id: 'google-calendar', name: 'Google Calendar' },
    { id: 'google-drive', name: 'Google Drive' },
    { id: 'google-docs', name: 'Google Docs' },
    { id: 'google-sheets', name: 'Google Sheets' },
    { id: 'google-slides', name: 'Google Slides' },
    { id: 'google-forms', name: 'Google Forms' },
    { id: 'google-contacts', name: 'Google Contacts' },
    { id: 'google-tasks', name: 'Google Tasks' },
  ];

  let accountEmail: string | undefined;
  let accountName: string | undefined;

  const results = await Promise.all(
    workspaceTargets.map(async (target) => {
      const start = Date.now();
      try {
        const ping = await pingNangoProvider(client, orgId, target.id);
        const latencyMs = Date.now() - start;

        if (target.id === 'gmail' && ping.ok && ping.data && typeof ping.data === 'object') {
          const d = ping.data as any;
          if (d.emailAddress) accountEmail = d.emailAddress;
        } else if (target.id === 'google-drive' && ping.ok && ping.data && typeof ping.data === 'object') {
          const d = ping.data as any;
          if (d.user?.displayName) accountName = d.user.displayName;
          if (d.user?.emailAddress && !accountEmail) accountEmail = d.user.emailAddress;
        }

        return {
          id: target.id,
          name: target.name,
          ok: ping.ok,
          status: ping.status,
          message: ping.message,
          data: ping.data,
          latencyMs,
        };
      } catch (err: any) {
        return {
          id: target.id,
          name: target.name,
          ok: false,
          status: err.status || 500,
          message: err.message || `${target.name} ping failed`,
          latencyMs: Date.now() - start,
        };
      }
    })
  );

  const passedCount = results.filter((r) => r.ok).length;
  const totalCount = results.length;
  const allPassed = passedCount === totalCount;

  return {
    connected: true,
    ok: passedCount > 0,
    provider: 'google-workspace',
    accountEmail,
    accountName,
    message: allPassed
      ? `All ${totalCount} Google Workspace services verified successfully`
      : `${passedCount} of ${totalCount} Google Workspace services verified`,
    services: results,
    allPassed,
    passedCount,
    totalCount,
  };
}
