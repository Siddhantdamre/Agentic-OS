import { NangoConnectorClient } from './client';
import { CONNECTORS_RECONNECT_URL, SendMessagePayload, notConnectedResult } from './types';

export async function sendWhatsAppMessage(
  client: NangoConnectorClient,
  orgId: string,
  phoneNumberId: string,
  payload: SendMessagePayload
) {
  const targetPhoneId = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  // 1. Direct Meta Cloud API when env credentials are present
  if (targetPhoneId && accessToken) {
    try {
      const response = await fetch(`https://graph.facebook.com/v18.0/${targetPhoneId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
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
      const authFailed = response.status === 401 || response.status === 403;
      return {
        success: response.ok,
        connected: !authFailed,
        status: response.status,
        metaCloudData: data,
        provider: 'whatsapp_meta_cloud_api',
        ...(authFailed
          ? {
              reconnectUrl: CONNECTORS_RECONNECT_URL,
              setupUrl: CONNECTORS_RECONNECT_URL,
            }
          : {}),
      };
    } catch (err: any) {
      console.warn('Meta Cloud API direct call fallback to Nango proxy:', err.message);
    }
  }

  // 2. Nango OAuth proxy — reachable when env token is absent or Meta direct call failed
  if (!targetPhoneId) {
    const honest = notConnectedResult(
      'not_connected',
      `WhatsApp phone number ID is missing. Connect at ${CONNECTORS_RECONNECT_URL} or set WHATSAPP_PHONE_NUMBER_ID.`,
      'whatsapp'
    );
    return {
      success: false,
      connected: false as const,
      status: 400,
      metaCloudData: { error: { message: honest.message } },
      provider: 'whatsapp_meta_cloud_api',
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
      reason: honest.reason,
    };
  }

  try {
    return await client.proxyRequest(orgId, 'whatsapp', `/${targetPhoneId}/messages`, 'POST', {
      messaging_product: 'whatsapp',
      to: payload.recipient,
      type: 'text',
      text: { body: payload.text },
    });
  } catch (err: any) {
    const honest = notConnectedResult(
      err?.reason === 'expired' || err?.reason === 'revoked' || err?.reason === 'nango_unconfigured'
        ? err.reason
        : 'not_connected',
      err?.message ||
        `WhatsApp is not connected. Reconnect at ${CONNECTORS_RECONNECT_URL}.`,
      'whatsapp'
    );
    return {
      success: false,
      connected: false as const,
      status: err?.status || 404,
      metaCloudData: { error: { message: honest.message } },
      provider: 'whatsapp_nango',
      reconnectUrl: honest.reconnectUrl,
      setupUrl: honest.setupUrl,
      reason: honest.reason,
    };
  }
}
