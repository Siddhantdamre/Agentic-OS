import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, nangoAuthError, notConnected, resolveGoogleAuth } from './shared.js';

const ACTIONS = ['business_list_locations'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const _gAuth = await resolveGoogleAuth(orgId, 'google-business-profile');
  const gToken: string | null = _gAuth.kind === 'connected' ? _gAuth.accessToken : null;
  const _gAuthErr = _gAuth.kind === 'connected' ? null : nangoAuthError('google-business-profile', actionName, timestamp, _gAuth);
  if (!gToken) return _gAuthErr ?? notConnected('google-business-profile', actionName, timestamp);

  try {
    const accountsRes = await fetchWithTimeout('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    const accountsData = await accountsRes.json().catch(() => ({}));
    if (!accountsRes.ok) {
      return apiError('google-business-profile', 'business_list_locations', timestamp, `Business Profile accounts failed: ${accountsRes.status}`, accountsData);
    }
    const accountName = payload.account || accountsData.accounts?.[0]?.name;
    if (!accountName) {
      return { tool: 'google-business-profile', action: 'business_list_locations', status: 'executed' as const, message: 'No Business Profile accounts found', data: { accounts: [] }, timestamp };
    }
    const locRes = await fetchWithTimeout(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,storefrontAddress,phoneNumbers,websiteUri`,
      { headers: { Authorization: `Bearer ${gToken}` } },
    );
    const locData = await locRes.json().catch(() => ({}));
    if (!locRes.ok) return apiError('google-business-profile', 'business_list_locations', timestamp, `Business Profile locations failed: ${locRes.status}`, locData);
    return {
      tool: 'google-business-profile',
      action: 'business_list_locations',
      status: 'executed' as const,
      message: `Listed locations for ${accountName}`,
      data: { account: accountName, accounts: accountsData.accounts || [], locations: locData.locations || [] },
      timestamp,
    };
  } catch (e: any) {
    console.error('[google-business-profile] API error:', e.message);
    return { tool: 'google-business-profile', action: actionName, status: 'error' as const, message: `google-business-profile request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleBusinessProfile: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
