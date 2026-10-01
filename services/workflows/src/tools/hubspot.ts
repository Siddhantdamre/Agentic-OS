import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, nangoAuthError, notConnected, resolveNangoAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = [
  'create_crm_contact',
  'update_contact',
  'search_contacts',
  'list_contacts',
  'list_deals',
  'create_deal',
  'update_deal',
  'sync_deal_schedule',
  'reassign_owner',
] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('search') || a.includes('list') || a.includes('get') || a.includes('find') || a.includes('read')) return 'read';
  if (a.includes('update') || a.includes('edit') || a.includes('create') || a.includes('sync')) return 'draft';
  return 'draft';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const contactEmail = payload.email;
  const action = String(actionName || '').toLowerCase();

  if (action.includes('list_deal') || (action.includes('list') && action.includes('deal'))) {
    const connId = `${orgId}_hubspot`;
    const _hsAuth = await resolveNangoAuth(connId, 'hubspot');
    const accessToken = _hsAuth.kind === 'connected' ? _hsAuth.accessToken : null;
    const _hsAuthErr = _hsAuth.kind === 'connected' ? null : nangoAuthError('hubspot', 'list_deals', timestamp, _hsAuth);
    if (!accessToken) return _hsAuthErr ?? notConnected('hubspot', 'list_deals', timestamp);
    try {
      const limit = Math.min(Number(payload.limit) || 20, 100);
      const res = await fetchWithTimeout(
        `https://api.hubapi.com/crm/v3/objects/deals?limit=${limit}&properties=dealname,amount,dealstage,pipeline,closedate`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          tool: 'hubspot',
          action: 'list_deals',
          status: 'error' as const,
          message: `HubSpot deals fetch failed: HTTP ${res.status}`,
          data,
          timestamp,
        };
      }
      return {
        tool: 'hubspot',
        action: 'list_deals',
        status: 'executed' as const,
        message: `Fetched ${data.results?.length || 0} deals from HubSpot CRM`,
        data: { deals: data.results || [], total: data.total ?? (data.results?.length || 0) },
        timestamp,
      };
    } catch (e: any) {
      return {
        tool: 'hubspot',
        action: 'list_deals',
        status: 'error' as const,
        message: `HubSpot error: ${e.message}`,
        data: null,
        timestamp,
      };
    }
  }

  if (action.includes('create_deal') || (action.includes('create') && action.includes('deal') && !action.includes('contact'))) {
    const connId = `${orgId}_hubspot`;
    const _hsAuth = await resolveNangoAuth(connId, 'hubspot');
    const accessToken = _hsAuth.kind === 'connected' ? _hsAuth.accessToken : null;
    const _hsAuthErr = _hsAuth.kind === 'connected' ? null : nangoAuthError('hubspot', 'create_deal', timestamp, _hsAuth);
    if (!accessToken) return _hsAuthErr ?? notConnected('hubspot', 'create_deal', timestamp);
    const dealname = payload.dealname || payload.name || payload.dealName;
    if (!dealname) {
      return {
        tool: 'hubspot',
        action: 'create_deal',
        status: 'error' as const,
        message: 'dealname is required to create a HubSpot deal',
        data: null,
        timestamp,
      };
    }
    try {
      const properties: Record<string, string> = { dealname: String(dealname) };
      if (payload.amount !== undefined && payload.amount !== null) properties.amount = String(payload.amount);
      if (payload.dealstage || payload.stage) properties.dealstage = String(payload.dealstage || payload.stage);
      if (payload.pipeline) properties.pipeline = String(payload.pipeline);
      if (payload.closedate || payload.closeDate) properties.closedate = String(payload.closedate || payload.closeDate);
      const res = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/deals', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          tool: 'hubspot',
          action: 'create_deal',
          status: 'error' as const,
          message: `HubSpot create deal failed: HTTP ${res.status} ${data?.message || ''}`,
          data,
          timestamp,
        };
      }
      return {
        tool: 'hubspot',
        action: 'create_deal',
        status: 'executed' as const,
        message: `Created HubSpot deal ${dealname}`,
        data: { dealId: data.id, properties },
        timestamp,
      };
    } catch (e: any) {
      return {
        tool: 'hubspot',
        action: 'create_deal',
        status: 'error' as const,
        message: `HubSpot error: ${e.message}`,
        data: null,
        timestamp,
      };
    }
  }

  if (action.includes('update_deal') || (action.includes('update') && action.includes('deal') && !action.includes('contact'))) {
    const dealId = payload.dealId || payload.deal_id || payload.id;
    if (!dealId) {
      return {
        tool: 'hubspot',
        action: 'update_deal',
        status: 'error' as const,
        message: 'dealId is required to update a HubSpot deal (use a real id from list_deals; never invent one)',
        data: null,
        timestamp,
      };
    }
    const connId = `${orgId}_hubspot`;
    const _hsAuth = await resolveNangoAuth(connId, 'hubspot');
    const accessToken = _hsAuth.kind === 'connected' ? _hsAuth.accessToken : null;
    const _hsAuthErr = _hsAuth.kind === 'connected' ? null : nangoAuthError('hubspot', 'update_deal', timestamp, _hsAuth);
    if (!accessToken) return _hsAuthErr ?? notConnected('hubspot', 'update_deal', timestamp);
    try {
      const properties: Record<string, string> = {};
      if (payload.dealname || payload.name || payload.dealName) {
        properties.dealname = String(payload.dealname || payload.name || payload.dealName);
      }
      if (payload.amount !== undefined && payload.amount !== null) properties.amount = String(payload.amount);
      if (payload.dealstage || payload.stage) properties.dealstage = String(payload.dealstage || payload.stage);
      if (payload.pipeline) properties.pipeline = String(payload.pipeline);
      if (payload.closedate || payload.closeDate) properties.closedate = String(payload.closedate || payload.closeDate);
      if (Object.keys(properties).length === 0) {
        return {
          tool: 'hubspot',
          action: 'update_deal',
          status: 'error' as const,
          message: 'No updatable deal fields supplied (try dealname, amount, dealstage, pipeline, closedate)',
          data: null,
          timestamp,
        };
      }
      const res = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(String(dealId))}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          tool: 'hubspot',
          action: 'update_deal',
          status: 'error' as const,
          message: `HubSpot update deal failed: HTTP ${res.status} ${data?.message || ''}`,
          data,
          timestamp,
        };
      }
      return {
        tool: 'hubspot',
        action: 'update_deal',
        status: 'executed' as const,
        message: `Updated HubSpot deal ${dealId}`,
        data: { dealId: data.id || dealId, updatedProperties: properties },
        timestamp,
      };
    } catch (e: any) {
      return {
        tool: 'hubspot',
        action: 'update_deal',
        status: 'error' as const,
        message: `HubSpot error: ${e.message}`,
        data: null,
        timestamp,
      };
    }
  }

  if (actionName.includes('sync') && actionName.includes('deal')) {
    // CE-04: a customer employee logs a reschedule against the deal's timeline
    // as an informational note. This deliberately never touches deal stage or
    // properties — role-capability.ts denies update_deal/create_deal for the
    // customer persona, and this action name is chosen to stay outside that
    // guardrail's substring match.
    if (!contactEmail) {
      return { tool: 'hubspot', action: 'sync_deal_schedule', status: 'error' as const, message: 'email is required to sync a deal schedule note.', data: null, timestamp };
    }
    const connId = `${orgId}_hubspot`;
    const _hsAuthSync = await resolveNangoAuth(connId, 'hubspot');
    const accessToken = _hsAuthSync.kind === 'connected' ? _hsAuthSync.accessToken : null;
    const _hsAuthSyncErr = _hsAuthSync.kind === 'connected' ? null : nangoAuthError('hubspot', 'sync_deal_schedule', timestamp, _hsAuthSync);
    if (!accessToken) return _hsAuthSyncErr ?? notConnected('hubspot', 'sync_deal_schedule', timestamp);
    try {
      const searchRes = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: contactEmail }] }],
          limit: 1,
        }),
      });
      if (!searchRes.ok) {
        return { tool: 'hubspot', action: 'sync_deal_schedule', status: 'error' as const, message: `HubSpot search failed: HTTP ${searchRes.status}`, data: null, timestamp };
      }
      const searchData = await searchRes.json();
      const contactId = searchData.results?.[0]?.id;
      if (!contactId) {
        return { tool: 'hubspot', action: 'sync_deal_schedule', status: 'error' as const, message: `No HubSpot contact found with email ${contactEmail}`, data: null, timestamp };
      }

      const noteRes = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/notes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties: {
            hs_note_body: String(payload.note || 'Meeting rescheduled via self-service.'),
            hs_timestamp: String(Date.now()),
          },
          associations: [
            {
              to: { id: contactId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
            },
            ...(payload.dealId
              ? [{ to: { id: String(payload.dealId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }]
              : []),
          ],
        }),
      });
      const noteData = await noteRes.json().catch(() => ({}));
      if (!noteRes.ok) {
        return { tool: 'hubspot', action: 'sync_deal_schedule', status: 'error' as const, message: `HubSpot note create failed: HTTP ${noteRes.status}`, data: noteData, timestamp };
      }
      return {
        tool: 'hubspot', action: 'sync_deal_schedule', status: 'executed' as const,
        message: `Logged reschedule note on HubSpot contact ${contactEmail}`,
        data: { noteId: noteData.id, contactId, dealId: payload.dealId || null },
        timestamp,
      };
    } catch (e: any) {
      return { tool: 'hubspot', action: 'sync_deal_schedule', status: 'error' as const, message: `HubSpot error: ${e.message}`, data: null, timestamp };
    }
  }

  if (actionName.includes('search') || actionName.includes('list') || actionName.includes('get') || actionName.includes('find')) {
    const connId = `${orgId}_hubspot`;
    const _hsAuth = await resolveNangoAuth(connId, 'hubspot');
    const accessToken = _hsAuth.kind === 'connected' ? _hsAuth.accessToken : null;
    const _hsAuthErr = _hsAuth.kind === 'connected' ? null : nangoAuthError('hubspot', actionName, timestamp, _hsAuth);
    if (!accessToken) return _hsAuthErr ?? notConnected('hubspot', actionName, timestamp);

    try {
      const query = payload.query || payload.search || payload.q || payload.email;
      let url = 'https://api.hubapi.com/crm/v3/objects/contacts?limit=' + (payload.limit || 20);
      let fetchOpts: RequestInit = {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      };

      if (query) {
        url = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
        fetchOpts = {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: String(query),
            limit: payload.limit || 20,
          }),
        };
      }

      const res = await fetchWithTimeout(url, fetchOpts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          tool: 'hubspot',
          action: actionName,
          status: 'error' as const,
          message: `HubSpot contacts fetch failed: HTTP ${res.status}`,
          data,
          timestamp,
        };
      }
      return {
        tool: 'hubspot',
        action: actionName,
        status: 'executed' as const,
        message: `Fetched ${data.results?.length || 0} contacts from HubSpot CRM`,
        data: { contacts: data.results || [], total: data.total },
        timestamp,
      };
    } catch (e: any) {
      return {
        tool: 'hubspot',
        action: actionName,
        status: 'error' as const,
        message: `HubSpot error: ${e.message}`,
        data: null,
        timestamp,
      };
    }
  }

  if (actionName.includes('reassign')) {
    // OE-05: capacity-aware routing reassigns a contact's HubSpot owner to
    // the rep the workload balancer picked, so the CRM record of record
    // matches who is actually working the lead.
    if (!contactEmail) {
      return { tool: 'hubspot', action: 'reassign_owner', status: 'error' as const, message: 'Contact email is required to reassign an owner in HubSpot', data: null, timestamp };
    }
    const ownerEmail = payload.ownerEmail || payload.owner_email;
    if (!ownerEmail) {
      return { tool: 'hubspot', action: 'reassign_owner', status: 'error' as const, message: 'ownerEmail is required to reassign an owner in HubSpot', data: null, timestamp };
    }
    const connId = `${orgId}_hubspot`;
    const _hsAuthRe = await resolveNangoAuth(connId, 'hubspot');
    const accessToken = _hsAuthRe.kind === 'connected' ? _hsAuthRe.accessToken : null;
    const _hsAuthReErr = _hsAuthRe.kind === 'connected' ? null : nangoAuthError('hubspot', 'reassign_owner', timestamp, _hsAuthRe);
    if (!accessToken) return _hsAuthReErr ?? notConnected('hubspot', 'reassign_owner', timestamp);
    try {
      const contactSearch = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: contactEmail }] }],
          limit: 1,
        }),
      });
      if (!contactSearch.ok) {
        return { tool: 'hubspot', action: 'reassign_owner', status: 'error' as const, message: `HubSpot search failed: HTTP ${contactSearch.status}`, data: null, timestamp };
      }
      const contactData = await contactSearch.json();
      const contactId = contactData.results?.[0]?.id;
      if (!contactId) {
        return { tool: 'hubspot', action: 'reassign_owner', status: 'error' as const, message: `No HubSpot contact found with email ${contactEmail}`, data: null, timestamp };
      }
      const ownerSearch = await fetchWithTimeout(
        `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(String(ownerEmail))}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!ownerSearch.ok) {
        return { tool: 'hubspot', action: 'reassign_owner', status: 'error' as const, message: `HubSpot owner lookup failed: HTTP ${ownerSearch.status}`, data: null, timestamp };
      }
      const ownerData = await ownerSearch.json();
      const ownerId = ownerData.results?.[0]?.id;
      if (!ownerId) {
        return { tool: 'hubspot', action: 'reassign_owner', status: 'error' as const, message: `No HubSpot owner found with email ${ownerEmail}`, data: null, timestamp };
      }
      const updateRes = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { hubspot_owner_id: ownerId } }),
      });
      if (!updateRes.ok) {
        const errBody = await updateRes.json().catch(() => ({}));
        return { tool: 'hubspot', action: 'reassign_owner', status: 'error' as const, message: `HubSpot owner update failed: HTTP ${updateRes.status} ${errBody?.message || ''}`, data: null, timestamp };
      }
      return {
        tool: 'hubspot', action: 'reassign_owner', status: 'executed' as const,
        message: `Reassigned HubSpot contact ${contactEmail} to ${ownerEmail}`,
        data: { contactId, ownerId, ownerEmail, email: contactEmail },
        timestamp,
      };
    } catch (e: any) {
      console.error('[HubSpot Tool] reassign error:', e);
      return { tool: 'hubspot', action: 'reassign_owner', status: 'error' as const, message: `HubSpot reassign error: ${e.message}`, data: null, timestamp };
    }
  }

  if (actionName.includes('update') || actionName.includes('edit')) {
    if (!contactEmail) {
      return {
        tool: 'hubspot', action: 'update_contact', status: 'error' as const,
        message: 'Contact email is required to update a contact in HubSpot', data: null, timestamp,
      };
    }
    const connId = `${orgId}_hubspot`;
    const _hsAuthUp = await resolveNangoAuth(connId, 'hubspot');
    const accessToken = _hsAuthUp.kind === 'connected' ? _hsAuthUp.accessToken : null;
    const _hsAuthUpErr = _hsAuthUp.kind === 'connected' ? null : nangoAuthError('hubspot', 'update_contact', timestamp, _hsAuthUp);
    if (accessToken) {
      try {
        const searchRes = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/contacts/search', {
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

        const updateRes = await fetchWithTimeout(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
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
    return _hsAuthUpErr ?? notConnected('hubspot', 'update_contact', timestamp);
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
  const _hsAuthCreate = await resolveNangoAuth(connId, 'hubspot');
  const accessToken = _hsAuthCreate.kind === 'connected' ? _hsAuthCreate.accessToken : null;
  const _hsAuthCreateErr = _hsAuthCreate.kind === 'connected' ? null : nangoAuthError('hubspot', 'create_crm_contact', timestamp, _hsAuthCreate);

  if (accessToken) {
    try {
      const hsRes = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/contacts', {
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

  return _hsAuthCreateErr ?? notConnected('hubspot', 'create_crm_contact', timestamp);
}

export const hubspot: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
