import type { ToolRisk } from './risk.js';
import type { NangoAuthState, ToolActionContext, ToolModule } from './shared.js';
import {
  apiError,
  confirmFromRisk,
  fetchWithTimeout,
  isProviderUnauthorized,
  notConnected,
  resolveNangoAuth,
  revoked,
} from './shared.js';

const ACTIONS = ['search_people', 'company_signals'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('search') || a.includes('signal') || a.includes('read')) return 'read';
  return 'draft';
}

async function linkedinAuth(orgId: string): Promise<NangoAuthState> {
  const primary = await resolveNangoAuth(`${orgId}_linkedin`, ['linkedin', 'linkedin-social']);
  if (primary.kind !== 'never-configured') return primary;
  return resolveNangoAuth(`${orgId}_linkedin-social`, ['linkedin', 'linkedin-social']);
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const auth = await linkedinAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('linkedin', actionName, timestamp);
  if (auth.kind === 'revoked') return revoked('linkedin', actionName, timestamp, auth.detail);

  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0',
  };

  try {
    if (actionName.includes('signal') || actionName.includes('company')) {
      const company = payload.company || payload.organization || payload.name;
      if (!company) {
        return apiError('linkedin', 'company_signals', timestamp, 'company is required');
      }
      const query = encodeURIComponent(String(company));
      const res = await fetchWithTimeout(
        `https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&projection=(elements*(organization~(id,localizedName)))&keywords=${query}`,
        { headers }
      );
      if (isProviderUnauthorized(res.status)) {
        return revoked('linkedin', 'company_signals', timestamp, 'LinkedIn token rejected');
      }
      if (!res.ok) {
        return apiError('linkedin', 'company_signals', timestamp, `LinkedIn API ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      return {
        tool: 'linkedin',
        action: 'company_signals',
        status: 'executed' as const,
        message: `Fetched LinkedIn organization signals for ${company}`,
        data: { company, elements: (data as { elements?: unknown }).elements || [] },
        timestamp,
      };
    }

    const keywords = payload.query || payload.keywords || payload.name;
    if (!keywords) {
      return apiError('linkedin', 'search_people', timestamp, 'query is required');
    }
    const res = await fetchWithTimeout(
      `https://api.linkedin.com/v2/peopleTypeahead?keywords=${encodeURIComponent(String(keywords))}`,
      { headers }
    );
    if (isProviderUnauthorized(res.status)) {
      return revoked('linkedin', 'search_people', timestamp, 'LinkedIn token rejected');
    }
    if (!res.ok) {
      return apiError('linkedin', 'search_people', timestamp, `LinkedIn API ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    return {
      tool: 'linkedin',
      action: 'search_people',
      status: 'executed' as const,
      message: `Searched LinkedIn people for "${keywords}"`,
      data: { query: keywords, elements: (data as { elements?: unknown }).elements || [] },
      timestamp,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError('linkedin', actionName, timestamp, message);
  }
}

export const linkedin: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
