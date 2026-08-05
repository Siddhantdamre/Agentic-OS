import { NangoConnectorClient } from './client.js';
import { SendMessagePayload } from './types.js';

export async function sendWhatsAppMessage(
  client: NangoConnectorClient,
  orgId: string,
  phoneNumberId: string,
  payload: SendMessagePayload
) {
  return client.proxyRequest(orgId, 'whatsapp', `/${phoneNumberId}/messages`, 'POST', {
    messaging_product: 'whatsapp',
    to: payload.recipient,
    type: 'text',
    text: { body: payload.text },
  });
}
