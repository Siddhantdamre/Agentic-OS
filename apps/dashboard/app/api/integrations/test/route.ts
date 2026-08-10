import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import {
  NangoConnectorClient,
  sendWhatsAppMessage,
  sendGmailEmail,
  createGoogleCalendarEvent,
  createHubspotContact,
  createRazorpayInvoice,
  getMetaAdsInsights,
  getGoogleAdsPerformance,
} from '@darex/connectors';

const nangoClient = new NangoConnectorClient();

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const { provider, payload } = await request.json();

    let result: any = null;
    let statusCode = 200;
    let message = '';

    try {
      switch (provider) {
        case 'whatsapp': {
          const phoneNumberId = payload.phoneNumberId || 'me';
          result = await sendWhatsAppMessage(nangoClient, orgId, phoneNumberId, {
            recipient: payload.recipient || '+14155552671',
            text: payload.text || 'Hello from DareX AI Employee!',
          });
          message = `WhatsApp message triggered for ${payload.recipient || 'recipient'}`;
          break;
        }

        case 'gmail': {
          result = await sendGmailEmail(nangoClient, orgId, {
            recipient: payload.recipient || 'user@example.com',
            text: payload.text || 'Hello from DareX AI Employee Email!',
          });
          message = `Gmail email sent to ${payload.recipient || 'recipient'}`;
          break;
        }

        case 'google-calendar': {
          result = await createGoogleCalendarEvent(nangoClient, orgId, {
            title: payload.title || 'DareX AI Strategy Call',
            description: payload.description || 'Discussing Q3 AI Workforce Deployment',
            startTime: payload.startTime || new Date(Date.now() + 3600000).toISOString(),
            endTime: payload.endTime || new Date(Date.now() + 7200000).toISOString(),
            attendeeEmails: payload.attendeeEmails || ['client@example.com'],
          });
          message = `Google Calendar event "${payload.title || 'Strategy Call'}" created`;
          break;
        }

        case 'hubspot': {
          result = await createHubspotContact(nangoClient, orgId, {
            email: payload.email || 'lead@example.com',
            firstName: payload.firstName || 'Jane',
            lastName: payload.lastName || 'Doe',
            company: payload.company || 'DareX Tech',
            phone: payload.phone || '+15550199',
          });
          message = `HubSpot contact created for ${payload.email || 'lead'}`;
          break;
        }

        case 'razorpay': {
          result = await createRazorpayInvoice(nangoClient, orgId, {
            customerEmail: payload.customerEmail || 'billing@example.com',
            amountInPaisa: payload.amountInPaisa || 499900,
            description: payload.description || 'DareX AI Pro Subscription Invoice',
          });
          message = `Razorpay invoice created for ${payload.customerEmail || 'customer'}`;
          break;
        }

        case 'meta-ads': {
          const adAccountId = payload.adAccountId || 'act_123456789';
          result = await getMetaAdsInsights(nangoClient, orgId, adAccountId);
          message = `Meta Ads insights fetched for ${adAccountId}`;
          break;
        }

        case 'google-ads': {
          const customerId = payload.customerId || '123-456-7890';
          result = await getGoogleAdsPerformance(nangoClient, orgId, customerId);
          message = `Google Ads performance metrics query executed for customer ${customerId}`;
          break;
        }

        default:
          return NextResponse.json({ message: `Unknown provider: ${provider}` }, { status: 400 });
      }
    } catch (err: any) {
      statusCode = err.status || 500;
      result = { error: err.message || 'API Proxy Execution Failed' };
      message = `${provider} execution error: ${err.message || 'Failed'}`;
    }

    // Record proxy call into channel_logs
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
      provider,
      message,
      statusCode,
      result,
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
