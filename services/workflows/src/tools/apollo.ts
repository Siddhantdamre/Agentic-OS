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

const ACTIONS = ['search_people', 'enrich_company'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('search') || a.includes('enrich') || a.includes('read')) return 'read';
  return 'draft';
}

async function apolloAuth(orgId: string): Promise<NangoAuthState> {
  const primary = await resolveNangoAuth(`${orgId}_apollo`, ['apollo', 'apollo-io']);
  if (primary.kind !== 'never-configured') return primary;
  return resolveNangoAuth(`${orgId}_apollo-io`, ['apollo', 'apollo-io']);
}

function apolloHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'X-Api-Key': token,
  };
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const auth = await apolloAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('apollo', actionName, timestamp);
  if (auth.kind === 'revoked') return revoked('apollo', actionName, timestamp, auth.detail);

  const headers = apolloHeaders(auth.accessToken);

  try {
    if (actionName.includes('enrich') || actionName.includes('company')) {
      const domain = payload.domain || payload.company_domain || payload.company;
      if (!domain) {
        return apiError('apollo', 'enrich_company', timestamp, 'domain is required');
      }
      const res = await fetchWithTimeout('https://api.apollo.io/api/v1/organizations/enrich', {
        method: 'POST',
        headers,
        body: JSON.stringify({ domain: String(domain) }),
      });
      if (isProviderUnauthorized(res.status)) {
        return revoked('apollo', 'enrich_company', timestamp, 'Apollo token rejected');
      }
      if (!res.ok) {
        return apiError('apollo', 'enrich_company', timestamp, `Apollo API ${res.status}`);
      }
      const data = await res.json().catch(() => ({}));
      return {
        tool: 'apollo',
        action: 'enrich_company',
        status: 'executed' as const,
        message: `Enriched Apollo company ${domain}`,
        data: { domain, organization: (data as { organization?: unknown }).organization || data },
        timestamp,
      };
    }

    const q = payload.query || payload.name || payload.email;
    if (!q) {
      return apiError('apollo', 'search_people', timestamp, 'query is required');
    }
    const res = await fetchWithTimeout('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ q_keywords: String(q), page: 1, per_page: 10 }),
    });
    if (isProviderUnauthorized(res.status)) {
      return revoked('apollo', 'search_people', timestamp, 'Apollo token rejected');
    }
    if (!res.ok) {
      return apiError('apollo', 'search_people', timestamp, `Apollo API ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    return {
      tool: 'apollo',
      action: 'search_people',
      status: 'executed' as const,
      message: `Searched Apollo people for "${q}"`,
      data: { query: q, people: (data as { people?: unknown }).people || [] },
      timestamp,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError('apollo', actionName, timestamp, message);
  }
}

export const apollo: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
