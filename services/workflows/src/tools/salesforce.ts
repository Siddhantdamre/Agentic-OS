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

const ACTIONS = ['list_contacts', 'create_contact', 'create_lead', 'list_deals', 'create_deal', 'update_deal'] as const;
const API_VERSION = 'v59.0';

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('fetch') || a.includes('query') || a.includes('read')) return 'read';
  return 'draft';
}

async function salesforceAuth(orgId: string): Promise<NangoAuthState> {
  return resolveNangoAuth(`${orgId}_salesforce`, ['salesforce']);
}

function instanceUrl(connection: Record<string, unknown>): string | null {
  const creds = (connection.credentials || {}) as Record<string, any>;
  const raw = (creds.raw || {}) as Record<string, any>;
  const cfg = (connection.connection_config || connection.metadata || {}) as Record<string, any>;
  const url =
    raw.instance_url
    || creds.instance_url
    || cfg.instance_url
    || process.env.SALESFORCE_INSTANCE_URL
    || '';
  const trimmed = String(url).replace(/\/+$/, '');
  return trimmed || null;
}

function soqlEscape(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sfHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const auth = await salesforceAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('salesforce', actionName, timestamp);
  if (auth.kind === 'revoked') return revoked('salesforce', actionName, timestamp, auth.detail);

  const base = instanceUrl(auth.connection);
  if (!base) {
    return apiError(
      'salesforce',
      actionName,
      timestamp,
      'Salesforce instance URL missing on the Nango connection (and SALESFORCE_INSTANCE_URL is unset). Re-connect at /connectors.',
    );
  }

  try {
    const action = String(actionName || '').toLowerCase();

    if (action.includes('list_deal') || (action.includes('list') && (action.includes('deal') || action.includes('opportunit')))) {
      const limit = Math.min(Number(payload.count) || Number(payload.limit) || 20, 50);
      const q = `SELECT Id, Name, Amount, StageName, CloseDate FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT ${limit}`;
      const res = await fetchWithTimeout(
        `${base}/services/data/${API_VERSION}/query?q=${encodeURIComponent(q)}`,
        { headers: sfHeaders(auth.accessToken) },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('salesforce', 'list_deals', timestamp, `Salesforce HTTP ${res.status}`);
      if (!res.ok) return apiError('salesforce', 'list_deals', timestamp, `Salesforce Opportunity query failed: HTTP ${res.status}`, data);
      const records = Array.isArray(data.records) ? data.records : [];
      return {
        tool: 'salesforce',
        action: 'list_deals',
        status: 'executed' as const,
        message: `Fetched ${records.length} Salesforce opportunities`,
        data: { totalSize: data.totalSize ?? records.length, deals: records, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (action.includes('update_deal') || (action.includes('update') && (action.includes('deal') || action.includes('opportunit')))) {
      const dealId = payload.dealId || payload.opportunityId || payload.id;
      if (!dealId) {
        return apiError(
          'salesforce',
          'update_deal',
          timestamp,
          'dealId is required to update a Salesforce Opportunity (use a real id from list_deals; never invent one)',
        );
      }
      const body: Record<string, string | number> = {};
      if (payload.name || payload.dealname) body.Name = String(payload.name || payload.dealname);
      if (payload.amount !== undefined && payload.amount !== null) body.Amount = Number(payload.amount);
      if (payload.stage || payload.stageName || payload.dealstage) {
        body.StageName = String(payload.stage || payload.stageName || payload.dealstage);
      }
      if (payload.closeDate || payload.closedate) body.CloseDate = String(payload.closeDate || payload.closedate);
      if (Object.keys(body).length === 0) {
        return apiError('salesforce', 'update_deal', timestamp, 'No updatable Opportunity fields supplied (try name, amount, stage, closeDate)');
      }
      const res = await fetchWithTimeout(
        `${base}/services/data/${API_VERSION}/sobjects/Opportunity/${encodeURIComponent(String(dealId))}`,
        { method: 'PATCH', headers: sfHeaders(auth.accessToken), body: JSON.stringify(body) },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('salesforce', 'update_deal', timestamp, `Salesforce HTTP ${res.status}`);
      if (!res.ok && res.status !== 204) {
        return apiError('salesforce', 'update_deal', timestamp, `Salesforce update Opportunity failed: HTTP ${res.status}`, data);
      }
      return {
        tool: 'salesforce',
        action: 'update_deal',
        status: 'executed' as const,
        message: `Updated Salesforce Opportunity ${dealId}`,
        data: { id: dealId, updated: body, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (action.includes('create_deal') || (action.includes('create') && (action.includes('deal') || action.includes('opportunit')))) {
      const name = payload.name || payload.dealname || payload.Name;
      const stage = payload.stage || payload.stageName || payload.dealstage || 'Prospecting';
      const closeDate = payload.closeDate || payload.closedate || new Date().toISOString().slice(0, 10);
      if (!name) return apiError('salesforce', 'create_deal', timestamp, 'name is required to create a Salesforce Opportunity.');
      const body: Record<string, string | number> = {
        Name: String(name),
        StageName: String(stage),
        CloseDate: String(closeDate),
      };
      if (payload.amount !== undefined && payload.amount !== null) body.Amount = Number(payload.amount);
      if (payload.accountId) body.AccountId = String(payload.accountId);
      const res = await fetchWithTimeout(`${base}/services/data/${API_VERSION}/sobjects/Opportunity/`, {
        method: 'POST',
        headers: sfHeaders(auth.accessToken),
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('salesforce', 'create_deal', timestamp, `Salesforce HTTP ${res.status}`);
      if (!res.ok) return apiError('salesforce', 'create_deal', timestamp, `Salesforce create Opportunity failed: HTTP ${res.status}`, data);
      return {
        tool: 'salesforce',
        action: 'create_deal',
        status: 'executed' as const,
        message: `Created Salesforce Opportunity ${data.id || ''}`.trim(),
        data: { id: data.id, success: data.success, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (actionName.includes('lead')) {
      const lastName = payload.lastName || payload.lastname || payload.name;
      const company = payload.company;
      if (!lastName) return apiError('salesforce', 'create_lead', timestamp, 'lastName is required to create a Salesforce Lead.');
      if (!company) return apiError('salesforce', 'create_lead', timestamp, 'company is required to create a Salesforce Lead.');
      const body: Record<string, string> = {
        LastName: String(lastName),
        Company: String(company),
      };
      if (payload.firstName || payload.firstname) body.FirstName = String(payload.firstName || payload.firstname);
      if (payload.email) body.Email = String(payload.email);
      if (payload.phone) body.Phone = String(payload.phone);
      const res = await fetchWithTimeout(`${base}/services/data/${API_VERSION}/sobjects/Lead/`, {
        method: 'POST',
        headers: sfHeaders(auth.accessToken),
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('salesforce', 'create_lead', timestamp, `Salesforce HTTP ${res.status}`);
      if (!res.ok) return apiError('salesforce', 'create_lead', timestamp, `Salesforce create Lead failed: HTTP ${res.status}`, data);
      return {
        tool: 'salesforce',
        action: 'create_lead',
        status: 'executed' as const,
        message: `Created Salesforce Lead ${data.id || ''}`.trim(),
        data: { id: data.id, success: data.success, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (actionName.includes('create') || actionName.includes('update')) {
      const lastName = payload.lastName || payload.lastname || payload.name;
      const email = payload.email;
      if (!lastName && !email) {
        return apiError('salesforce', 'create_contact', timestamp, 'lastName or email is required to create a Salesforce Contact.');
      }
      const body: Record<string, string> = {};
      if (lastName) body.LastName = String(lastName);
      if (payload.firstName || payload.firstname) body.FirstName = String(payload.firstName || payload.firstname);
      if (email) body.Email = String(email);
      if (payload.phone) body.Phone = String(payload.phone);
      if (payload.accountId) body.AccountId = String(payload.accountId);
      const res = await fetchWithTimeout(`${base}/services/data/${API_VERSION}/sobjects/Contact/`, {
        method: 'POST',
        headers: sfHeaders(auth.accessToken),
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('salesforce', 'create_contact', timestamp, `Salesforce HTTP ${res.status}`);
      if (!res.ok) return apiError('salesforce', 'create_contact', timestamp, `Salesforce create Contact failed: HTTP ${res.status}`, data);
      return {
        tool: 'salesforce',
        action: 'create_contact',
        status: 'executed' as const,
        message: `Created Salesforce Contact ${data.id || ''}`.trim(),
        data: { id: data.id, success: data.success, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    const limit = Math.min(Number(payload.count) || 10, 50);
    const emailFilter = payload.email ? ` WHERE Email = '${soqlEscape(String(payload.email))}'` : '';
    const q = `SELECT Id, FirstName, LastName, Email, Phone FROM Contact${emailFilter} LIMIT ${limit}`;
    const res = await fetchWithTimeout(
      `${base}/services/data/${API_VERSION}/query?q=${encodeURIComponent(q)}`,
      { headers: sfHeaders(auth.accessToken) },
    );
    const data = await res.json().catch(() => ({}));
    if (isProviderUnauthorized(res.status)) return revoked('salesforce', 'list_contacts', timestamp, `Salesforce HTTP ${res.status}`);
    if (!res.ok) return apiError('salesforce', 'list_contacts', timestamp, `Salesforce query failed: HTTP ${res.status}`, data);
    const records = Array.isArray(data.records) ? data.records : [];
    return {
      tool: 'salesforce',
      action: 'list_contacts',
      status: 'executed' as const,
      message: `Fetched ${records.length} Salesforce contacts`,
      data: { totalSize: data.totalSize ?? records.length, contacts: records, httpStatus: res.status, connected: true },
      timestamp,
    };
  } catch (e: any) {
    return apiError('salesforce', actionName, timestamp, `Salesforce API error: ${e.message}`);
  }
}

export const salesforce: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
