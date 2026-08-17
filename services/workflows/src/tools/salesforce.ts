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

const ACTIONS = ['list_contacts', 'create_contact', 'create_lead'] as const;
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
