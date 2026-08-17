import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['create_crm_contact', 'update_contact'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('update') || a.includes('edit') || a.includes('create')) return 'draft';
  return 'draft';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const contactEmail = payload.email;

  if (actionName.includes('update') || actionName.includes('edit')) {
    if (!contactEmail) {
      return {
        tool: 'hubspot', action: 'update_contact', status: 'error' as const,
        message: 'Contact email is required to update a contact in HubSpot', data: null, timestamp,
      };
    }
    const connId = `${orgId}_hubspot`;
    const accessToken = await getNangoAccessToken(connId, 'hubspot');
    if (accessToken) {
      try {
        const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: contactEmail }] }],
            limit: 1,
          }),
        });
        if (!searchRes.ok) {
          return { tool: 'hubspot', action: 'update_contact', status: 'error' as const, message: `HubSpot search failed: HTTP ${searchRes.status}`, data: null, timestamp };
        }
        const searchData = await searchRes.json();
        const contactId = searchData.results?.[0]?.id;
        if (!contactId) {
          return { tool: 'hubspot', action: 'update_contact', status: 'error' as const, message: `No HubSpot contact found with email ${contactEmail}`, data: null, timestamp };
        }

        const properties: Record<string, string> = {};
        const editable = ['firstname', 'lastname', 'phone', 'jobtitle', 'lifecyclestage', 'company', 'website', 'address', 'city', 'country', 'notes_last_contacted', 'hs_lead_status'];
        for (const key of editable) {
          if (payload[key] !== undefined && payload[key] !== null) properties[key] = String(payload[key]);
        }
        if (Object.keys(properties).length === 0) {
          return { tool: 'hubspot', action: 'update_contact', status: 'error' as const, message: 'No updatable fields supplied (try firstname, lastname, phone, jobtitle, lifecyclestage, company)', data: null, timestamp };
        }

        const updateRes = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ properties }),
        });
        if (updateRes.ok) {
          const hsData = await updateRes.json();
          return {
            tool: 'hubspot', action: 'update_contact', status: 'executed' as const,
            message: `Updated HubSpot contact ${contactEmail}`,
            data: { contactId: hsData.id, email: contactEmail, updatedProperties: properties },
            timestamp,
          };
        }
        const errBody = await updateRes.json().catch(() => ({}));
        return { tool: 'hubspot', action: 'update_contact', status: 'error' as const, message: `HubSpot update failed: HTTP ${updateRes.status} ${errBody?.message || ''}`, data: null, timestamp };
      } catch (e: any) {
        console.error('[HubSpot Tool] update error:', e);
        return { tool: 'hubspot', action: 'update_contact', status: 'error' as const, message: `HubSpot update error: ${e.message}`, data: null, timestamp };
      }
    }
    return notConnected('hubspot', 'update_contact', timestamp);
  }

  if (!contactEmail) {
    return {
      tool: 'hubspot',
      action: 'create_crm_contact',
      status: 'error' as const,
      message: 'Contact email parameter is required to create a contact in HubSpot',
      data: null,
      timestamp,
    };
  }
  const connId = `${orgId}_hubspot`;
  const accessToken = await getNangoAccessToken(connId, 'hubspot');

  if (accessToken) {
    try {
      const hsRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties: {
            email: contactEmail,
            firstname: payload.firstname || '',
            lastname: payload.lastname || '',
            lifecyclestage: 'lead',
          },
        }),
      });

      if (hsRes.ok) {
        const hsData = await hsRes.json();
        return {
          tool: 'hubspot',
          action: 'create_crm_contact',
          status: 'executed' as const,
          message: `✅ Created contact ${contactEmail} in HubSpot CRM`,
          data: {
            vid: hsData.id,
            email: contactEmail,
            firstname: payload.firstname || '',
            lastname: payload.lastname || '',
            lifecycleStage: 'lead',
          },
          timestamp,
        };
      }
    } catch (e: any) {
      console.error('[HubSpot Tool] API error:', e);
    }
  }

  return notConnected('hubspot', 'create_crm_contact', timestamp);
}

export const hubspot: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
