import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, nangoAuthError, notConnected, resolveGoogleAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = ['contacts_list'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const _gAuth = await resolveGoogleAuth(orgId, 'google-contacts');
  const gToken: string | null = _gAuth.kind === 'connected' ? _gAuth.accessToken : null;
  const _gAuthErr = _gAuth.kind === 'connected' ? null : nangoAuthError('google-contacts', actionName, timestamp, _gAuth);
  if (!gToken) return _gAuthErr ?? notConnected('google-contacts', actionName, timestamp);

  try {
    const contactsRes = await fetchWithTimeout(`https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=${payload.pageSize || 50}`, {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    if (!contactsRes.ok) {
      return { tool: 'google-contacts', action: 'contacts_list', status: 'error' as const, message: `Contacts error ${contactsRes.status}: ${await contactsRes.text()}`, data: null, timestamp };
    }
    const contactsData = await contactsRes.json();
    return {
      tool: 'google-contacts',
      action: 'contacts_list',
      status: 'executed' as const,
      message: `Fetched ${contactsData.connections?.length || 0} contacts`,
      data: { connections: contactsData.connections || [] },
      timestamp,
    };
  } catch (e: any) {
    console.error('[google-contacts] API error:', e.message);
    return { tool: 'google-contacts', action: actionName, status: 'error' as const, message: `google-contacts request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleContacts: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
