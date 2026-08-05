import { NangoConnectorClient } from './client.js';
import { CreateHubspotContactPayload } from './types.js';

export async function createHubspotContact(
  client: NangoConnectorClient,
  orgId: string,
  payload: CreateHubspotContactPayload
) {
  return client.proxyRequest(orgId, 'hubspot', '/crm/v3/objects/contacts', 'POST', {
    properties: {
      email: payload.email,
      firstname: payload.firstName || '',
      lastname: payload.lastName || '',
      phone: payload.phone || '',
      company: payload.company || '',
    },
  });
}
