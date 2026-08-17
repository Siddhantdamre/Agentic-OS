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
const API_VERSION = 'v2';

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('fetch') || a.includes('query') || a.includes('read')) return 'read';
  return 'draft';
}

async function zohoAuth(orgId: string): Promise<NangoAuthState> {
  const primary = await resolveNangoAuth(`${orgId}_zoho-crm`, ['zoho-crm', 'zoho']);
  if (primary.kind !== 'never-configured') return primary;
  return resolveNangoAuth(`${orgId}_zoho`, ['zoho-crm', 'zoho']);
}

function apiDomain(connection: Record<string, unknown>): string {
  const creds = (connection.credentials || {}) as Record<string, any>;
  const raw = (creds.raw || {}) as Record<string, any>;
  const cfg = (connection.connection_config || connection.metadata || {}) as Record<string, any>;
  const url =
    raw.api_domain
    || creds.api_domain
    || cfg.api_domain
    || process.env.ZOHO_API_DOMAIN
    || 'https://www.zohoapis.com';
  return String(url).replace(/\/+$/, '');
}

function zohoHeaders(token: string): Record<string, string> {
  return { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' };
}

function firstRecord(data: Record<string, any>): Record<string, any> | null {
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows[0] && typeof rows[0] === 'object' ? rows[0] : null;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const auth = await zohoAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('zoho-crm', actionName, timestamp);
  if (auth.kind === 'revoked') return revoked('zoho-crm', actionName, timestamp, auth.detail);

  const base = apiDomain(auth.connection);
  const headers = zohoHeaders(auth.accessToken);
  const crmBase = `${base}/crm/${API_VERSION}`;

  try {
    if (actionName.includes('lead')) {
      const lastName = payload.lastName || payload.lastname || payload.Last_Name || payload.name;
      const company = payload.company || payload.Company;
      if (!lastName) return apiError('zoho-crm', 'create_lead', timestamp, 'lastName is required to create a Zoho Lead.');
      if (!company) return apiError('zoho-crm', 'create_lead', timestamp, 'company is required to create a Zoho Lead.');
      const record: Record<string, string> = {
        Last_Name: String(lastName),
        Company: String(company),
      };
      if (payload.firstName || payload.firstname || payload.First_Name) {
        record.First_Name = String(payload.firstName || payload.firstname || payload.First_Name);
      }
      if (payload.email || payload.Email) record.Email = String(payload.email || payload.Email);
      if (payload.phone || payload.Phone) record.Phone = String(payload.phone || payload.Phone);
      const res = await fetchWithTimeout(`${crmBase}/Leads`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: [record] }),
      });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('zoho-crm', 'create_lead', timestamp, `Zoho HTTP ${res.status}`);
      if (!res.ok) return apiError('zoho-crm', 'create_lead', timestamp, `Zoho create Lead failed: HTTP ${res.status}`, data);
      const row = firstRecord(data);
      if (row && String(row.status || '').toLowerCase() === 'error') {
        return apiError('zoho-crm', 'create_lead', timestamp, `Zoho create Lead failed: ${row.message || row.code || 'error'}`, data);
      }
      return {
        tool: 'zoho-crm',
        action: 'create_lead',
        status: 'executed' as const,
        message: `Created Zoho Lead ${row?.details?.id || ''}`.trim(),
        data: { id: row?.details?.id, status: row?.status, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (actionName.includes('create') || actionName.includes('update')) {
      const lastName = payload.lastName || payload.lastname || payload.Last_Name || payload.name;
      const email = payload.email || payload.Email;
      if (!lastName && !email) {
        return apiError('zoho-crm', 'create_contact', timestamp, 'lastName or email is required to create a Zoho Contact.');
      }
      const record: Record<string, string> = {};
      if (lastName) record.Last_Name = String(lastName);
      if (payload.firstName || payload.firstname || payload.First_Name) {
        record.First_Name = String(payload.firstName || payload.firstname || payload.First_Name);
      }
      if (email) record.Email = String(email);
      if (payload.phone || payload.Phone) record.Phone = String(payload.phone || payload.Phone);
      const res = await fetchWithTimeout(`${crmBase}/Contacts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ data: [record] }),
      });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('zoho-crm', 'create_contact', timestamp, `Zoho HTTP ${res.status}`);
      if (!res.ok) return apiError('zoho-crm', 'create_contact', timestamp, `Zoho create Contact failed: HTTP ${res.status}`, data);
      const row = firstRecord(data);
      if (row && String(row.status || '').toLowerCase() === 'error') {
        return apiError('zoho-crm', 'create_contact', timestamp, `Zoho create Contact failed: ${row.message || row.code || 'error'}`, data);
      }
      return {
        tool: 'zoho-crm',
        action: 'create_contact',
        status: 'executed' as const,
        message: `Created Zoho Contact ${row?.details?.id || ''}`.trim(),
        data: { id: row?.details?.id, status: row?.status, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    const limit = Math.min(Number(payload.count) || 10, 50);
    const email = payload.email || payload.Email;
    const url = email
      ? `${crmBase}/Contacts/search?email=${encodeURIComponent(String(email))}`
      : `${crmBase}/Contacts?per_page=${limit}`;
    const res = await fetchWithTimeout(url, { headers });
    const data = await res.json().catch(() => ({}));
    if (isProviderUnauthorized(res.status)) return revoked('zoho-crm', 'list_contacts', timestamp, `Zoho HTTP ${res.status}`);
    if (res.status === 204) {
      return {
        tool: 'zoho-crm',
        action: 'list_contacts',
        status: 'executed' as const,
        message: 'Fetched 0 Zoho contacts',
        data: { totalSize: 0, contacts: [], httpStatus: res.status, connected: true },
        timestamp,
      };
    }
    if (!res.ok) return apiError('zoho-crm', 'list_contacts', timestamp, `Zoho query failed: HTTP ${res.status}`, data);
    const records = Array.isArray(data.data) ? data.data : [];
    return {
      tool: 'zoho-crm',
      action: 'list_contacts',
      status: 'executed' as const,
      message: `Fetched ${records.length} Zoho contacts`,
      data: { totalSize: data.info?.count ?? records.length, contacts: records, httpStatus: res.status, connected: true },
      timestamp,
    };
  } catch (e: any) {
    return apiError('zoho-crm', actionName, timestamp, `Zoho API error: ${e.message}`);
  }
}

export const zoho: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
