import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
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
} from '@darex/connectors';
import { getIntegration, isIntegrationId } from '@/lib/integrations-catalog';

function getNangoClient(): NangoConnectorClient {
  return new NangoConnectorClient();
}

function whatsappCredsFromMeta(meta: Record<string, unknown> | null | undefined): {
  accessToken: string;
  phoneNumberId: string;
} | null {
  const src = meta && typeof meta === 'object' ? meta : {};
  const accessToken = String(src.accessToken || src.meta_access_token || process.env.META_ACCESS_TOKEN || '');
  const phoneNumberId = String(src.phoneNumberId || src.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID || '');
  if (!accessToken || !phoneNumberId) return null;
  return { accessToken, phoneNumberId };
}

function razorpayCredsFromMeta(meta: Record<string, unknown> | null | undefined): {
  keyId: string;
  keySecret: string;
} | null {
  const src = meta && typeof meta === 'object' ? meta : {};
  const keyId = String(src.keyId || src.key_id || process.env.RAZORPAY_KEY_ID || '');
  const keySecret = String(src.keySecret || src.key_secret || process.env.RAZORPAY_KEY_SECRET || '');
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { provider, payload: rawPayload } = await request.json();
      const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};

      if (!provider || !isIntegrationId(provider)) {
        return NextResponse.json({ message: `Unknown provider: ${provider || '(missing)'}` }, { status: 400 });
      }

      const spec = getIntegration(provider);
      const channelRes = await client.query(
        `SELECT status, meta, nango_connection_id FROM channels WHERE org_id = $1 AND channel_type = $2`,
        [orgId, provider]
      );
      const channel = channelRes.rows[0] as { status?: string; meta?: Record<string, unknown>; nango_connection_id?: string } | undefined;

      let result: any = null;
      let statusCode = 200;
      let message = '';
      let connected = false;

      try {
        if (provider === 'whatsapp') {
          const creds = whatsappCredsFromMeta(channel?.meta);
          if (!creds) {
            statusCode = 404;
            connected = false;
            message = 'WhatsApp is not connected. Paste a Meta system-user token at /connectors.';
            result = { connected: false, setupUrl: '/connectors' };
          } else if (payload.recipient && payload.text) {
            const sent = await sendWhatsAppWithCreds(creds, {
              recipient: String(payload.recipient),
              text: String(payload.text),
            });
            connected = true;
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
            message = 'Razorpay keys are not set (per-org or RAZORPAY_KEY_ID/SECRET env).';
            result = { connected: false, setupUrl: '/connectors' };
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
        } else if (spec?.authMode === 'service_account') {
          statusCode = 400;
          message = `${spec.name} is service-account only — there is no OAuth connect or diagnostic ping.`;
          result = { connected: false, setupUrl: '/connectors' };
        } else if (provider === 'gmail' && payload.recipient && payload.text) {
          const nangoClient = getNangoClient();
          result = await sendGmailEmail(nangoClient, orgId, {
            recipient: String(payload.recipient),
            text: String(payload.text),
          });
          connected = true;
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
        result = { error: err.message || 'API Proxy Execution Failed', connected: false, setupUrl: '/connectors' };
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
        setupUrl: statusCode === 200 ? undefined : '/connectors',
      });
    } finally {
      client.release();
    }
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Integration Test Error:', err);
    return NextResponse.json({ message: err.message }, { status: 500 });
  }
}
