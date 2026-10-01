import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { denyUnlessConnectorManager } from '@/lib/connector-rbac';
import {
  NangoConnectorClient,
  createGoogleCalendarEvent,
  createHubspotContact,
  createRazorpayInvoiceWithCreds,
  pingNangoProvider,
  pingRazorpay,
  pingWhatsApp,
  sendGmailEmail,
  sendWhatsAppWithCreds,
  testGoogleWorkspace,
} from '@darex/connectors';
import {
  getEvolutionState,
  openSecret,
  providerIdOf,
  sendWhatsApp as sendWhatsAppViaGateway,
} from '@darex/whatsapp-gateway';
import { getIntegration, isIntegrationId } from '@/lib/integrations-catalog';

function getNangoClient(): NangoConnectorClient {
  return new NangoConnectorClient();
}

function whatsappCredsFromMeta(meta: Record<string, unknown> | null | undefined): {
  accessToken: string;
  phoneNumberId: string;
} | null {
  const src = meta && typeof meta === 'object' ? meta : {};
  // Per-org BYOK only — never fall back to process env (would leak a global
  // token across tenants on the diagnostic route).
  let accessToken = String(src.accessToken || src.meta_access_token || '');
  try {
    accessToken = accessToken ? openSecret(accessToken) : '';
  } catch {
    return null; // sealed token that cannot be opened: treat as not connected
  }
  const phoneNumberId = String(src.phoneNumberId || src.phone_number_id || '');
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId };
}

function razorpayCredsFromMeta(meta: Record<string, unknown> | null | undefined): {
  keyId: string;
  keySecret: string;
} | null {
  const src = meta && typeof meta === 'object' ? meta : {};
  const keyId = String(src.keyId || src.key_id || '');
  const keySecret = String(src.keySecret || src.key_secret || '');
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const forbidden = await denyUnlessConnectorManager(client, userId);
      if (forbidden) return forbidden;
      const { provider, payload: rawPayload } = await request.json();
      const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

      if (!provider || !isIntegrationId(provider)) {
        return NextResponse.json({ message: `Unknown provider: ${provider || '(missing)'}` }, { status: 400 });
      }

      const spec = getIntegration(provider);
      const channelRes = await client.query(
        `SELECT status, meta, nango_connection_id FROM channels WHERE org_id = $1 AND channel_type = $2 AND account_key = ''`,
        [orgId, provider]
      );
      const channel = channelRes.rows[0] as { status?: string; meta?: Record<string, unknown>; nango_connection_id?: string } | undefined;

      let result: any = null;
      let statusCode = 200;
      let message = '';
      let connected = false;

      try {
        if (provider === 'whatsapp' && providerIdOf(channel?.meta) === 'evolution') {
          // QR-linked number: check the live session, or send through the gateway.
          const instance = String(channel?.meta?.evolution_instance || '');
          if (payload.recipient && payload.text) {
            const sent = await sendWhatsAppViaGateway(channel?.meta || {}, {
              to: String(payload.recipient),
              text: String(payload.text),
            });
            connected = sent.ok;
            statusCode = sent.ok ? 200 : sent.status || 502;
            result = { messageId: sent.messageId, provider: 'evolution' };
            message = sent.ok ? `WhatsApp message sent to ${payload.recipient}` : sent.message;
          } else {
            const live = await getEvolutionState(instance);
            connected = live.state === 'open';
            statusCode = connected ? 200 : 503;
            result = { provider: 'evolution', state: live.state };
            message = connected
              ? 'WhatsApp (QR) session is linked'
              : 'WhatsApp (QR) session is not linked - scan the QR again at /connectors.';
          }
        } else if (provider === 'whatsapp') {
          const creds = whatsappCredsFromMeta(channel?.meta);
          if (!creds) {
            statusCode = 404;
            connected = false;
            message = 'WhatsApp is not connected. Paste a Meta system-user token at /connectors.';
            result = { connected: false, reconnectUrl: '/connectors', setupUrl: '/connectors' };
          } else if (payload.recipient && payload.text) {
            const sent = await sendWhatsAppWithCreds(creds, {
              recipient: String(payload.recipient),
              text: String(payload.text),
            });
            connected = sent.ok;
            statusCode = sent.status;
            result = sent.data;
            message = sent.ok
              ? `WhatsApp message sent to ${payload.recipient}`
              : `WhatsApp send failed (HTTP ${sent.status}). Rotate the Meta token if this is 401.`;
          } else {
            const ping = await pingWhatsApp(creds);
            connected = ping.ok;
            statusCode = ping.status;
            result = ping;
            message = ping.message;
          }
        } else if (provider === 'razorpay') {
          const creds = razorpayCredsFromMeta(channel?.meta);
          if (!creds) {
            statusCode = 404;
            message = 'Razorpay keys are not set for this org. Connect at /connectors.';
            result = { connected: false, reconnectUrl: '/connectors', setupUrl: '/connectors' };
          } else if (payload.customerEmail && payload.amountInPaisa) {
            const created = await createRazorpayInvoiceWithCreds(creds, {
              customerEmail: String(payload.customerEmail),
              amountInPaisa: Number(payload.amountInPaisa),
              description: String(payload.description || 'Darex test invoice'),
            });
            connected = created.ok;
            statusCode = created.status;
            result = created.data;
            message = created.ok
              ? `Razorpay invoice created for ${payload.customerEmail}`
              : `Razorpay invoice failed (HTTP ${created.status})`;
          } else {
            const ping = await pingRazorpay(creds);
            connected = ping.ok;
            statusCode = ping.status;
            result = ping;
            message = ping.message;
          }
        } else if (provider === 'google-workspace' || provider === 'google') {
          const nangoClient = getNangoClient();
          const suite = await testGoogleWorkspace(nangoClient, orgId);
          connected = suite.connected;
          statusCode = suite.ok ? 200 : (suite.connected ? 207 : 404);
          result = suite;
          message = suite.message;
        } else if (spec?.authMode === 'service_account') {
          statusCode = 400;
          message = `${spec.name} is service-account only — there is no OAuth connect or diagnostic ping.`;
          result = { connected: false, reconnectUrl: '/connectors', setupUrl: '/connectors' };
        } else if (provider === 'gmail' && payload.recipient && payload.text) {
          const nangoClient = getNangoClient();
          result = await sendGmailEmail(nangoClient, orgId, {
            recipient: String(payload.recipient),
            text: String(payload.text),
          });
          // proxyRequest throws on missing/expired OAuth — reaching here means live creds worked
          connected = true;
          statusCode = 200;
          message = `Gmail email sent to ${payload.recipient}`;
        } else if (provider === 'google-calendar' && payload.title) {
          const nangoClient = getNangoClient();
          const attendeeEmails = Array.isArray(payload.attendeeEmails)
            ? payload.attendeeEmails
            : String(payload.attendeesStr || '')
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean);
          result = await createGoogleCalendarEvent(nangoClient, orgId, {
            title: String(payload.title),
            description: payload.description ? String(payload.description) : undefined,
            startTime: payload.startTime || new Date(Date.now() + 3600000).toISOString(),
            endTime: payload.endTime || new Date(Date.now() + 7200000).toISOString(),
            attendeeEmails,
          });
          connected = true;
          statusCode = 200;
          message = `Google Calendar event "${payload.title}" created`;
        } else if (provider === 'hubspot' && payload.email) {
          const nangoClient = getNangoClient();
          result = await createHubspotContact(nangoClient, orgId, {
            email: String(payload.email),
            firstName: payload.firstName ? String(payload.firstName) : undefined,
            lastName: payload.lastName ? String(payload.lastName) : undefined,
            company: payload.company ? String(payload.company) : undefined,
            phone: payload.phone ? String(payload.phone) : undefined,
          });
          connected = true;
          statusCode = 200;
          message = `HubSpot contact created for ${payload.email}`;
        } else {
          const nangoClient = getNangoClient();
          const ping = await pingNangoProvider(nangoClient, orgId, provider);
          connected = ping.ok;
          statusCode = ping.status;
          result = ping;
          message = ping.message;
          if (spec?.executorStatus === 'catalog_only' && ping.ok) {
            message = `${ping.message} Agent tools for ${spec.name} are not implemented yet.`;
          }
        }
      } catch (err: any) {
        statusCode = err.status || 500;
        connected = err.connected === true;
        const reconnectUrl = err.reconnectUrl || '/connectors';
        result = {
          error: err.message || 'API Proxy Execution Failed',
          connected: false,
          reconnectUrl,
          setupUrl: reconnectUrl,
          reason: err.reason,
        };
        message = `${provider} execution error: ${err.message || 'Failed'}`;
      }

      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload, response)
         VALUES ($1, $2, 'proxy_call', $3, $4, $5, $6, $7)`,
        [
          orgId,
          provider,
          statusCode === 200 ? 'success' : 'error',
          statusCode,
          message,
          JSON.stringify(payload || {}),
          JSON.stringify(result || {}),
        ]
      );

      return NextResponse.json({
        success: statusCode === 200,
        connected,
        provider,
        message,
        statusCode,
        result,
        executorStatus: spec?.executorStatus,
        reconnectUrl: connected ? undefined : '/connectors',
        setupUrl: statusCode === 200 ? undefined : '/connectors',
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    console.error('Integration Test Error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
