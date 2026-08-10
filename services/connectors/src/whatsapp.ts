import { NangoConnectorClient } from './client';
import { SendMessagePayload } from './types';

export async function sendWhatsAppMessage(
  client: NangoConnectorClient,
  orgId: string,
  phoneNumberId: string,
  payload: SendMessagePayload
) {
  const targetPhoneId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!targetPhoneId || !accessToken) {
    return {
      success: false,
      status: 400,
      metaCloudData: { error: { message: 'WHATSAPP_PHONE_NUMBER_ID and META_ACCESS_TOKEN must be configured' } },
      provider: 'whatsapp_meta_cloud_api',
    };
  }

  // 1. If direct Meta Access Token is provided, dispatch directly to Meta Graph API
  if (accessToken) {
    try {
      const response = await fetch(`https://graph.facebook.com/v18.0/${targetPhoneId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: payload.recipient,
          type: 'text',
          text: { body: payload.text },
        }),
      });

      const data = await response.json();
      return {
        success: response.ok,
        status: response.status,
        metaCloudData: data,
        provider: 'whatsapp_meta_cloud_api',
      };
    } catch (err: any) {
      console.warn('Meta Cloud API direct call fallback to Nango proxy:', err.message);
    }
  }

  // 2. Nango Connector Proxy fallback
  return client.proxyRequest(orgId, 'whatsapp', `/${targetPhoneId}/messages`, 'POST', {
    messaging_product: 'whatsapp',
    to: payload.recipient,
    type: 'text',
    text: { body: payload.text },
  });
}
