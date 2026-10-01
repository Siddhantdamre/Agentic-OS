import { NangoConnectorClient } from './client';
import { SendMessagePayload } from './types';

export async function sendGmailEmail(
  client: NangoConnectorClient,
  orgId: string,
  payload: SendMessagePayload
) {
  // Construct RFC 2822 base64 message
  const rawMessage = `To: ${payload.recipient}\r\nSubject: Update from DareX AI\r\n\r\n${payload.text}`;
  const encodedMessage = Buffer.from(rawMessage).toString('base64url');

  return client.proxyRequest(orgId, 'gmail', '/gmail/v1/users/me/messages/send', 'POST', {
    raw: encodedMessage,
  });
}
