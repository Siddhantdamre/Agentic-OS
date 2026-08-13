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

const ACTIONS = ['list_customers', 'create_customer', 'list_invoices'] as const;
const PROD_API_BASE = 'https://quickbooks.api.intuit.com';
const SANDBOX_API_BASE = 'https://sandbox-quickbooks.api.intuit.com';

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('fetch') || a.includes('query') || a.includes('read')) return 'read';
  return 'draft';
}

async function quickbooksAuth(orgId: string): Promise<NangoAuthState> {
  return resolveNangoAuth(`${orgId}_quickbooks`, ['quickbooks', 'quickbooks-sandbox']);
}

function apiBase(): string {
  if (process.env.QUICKBOOKS_API_BASE_URL) return String(process.env.QUICKBOOKS_API_BASE_URL).replace(/\/+$/, '');
  const env = String(process.env.QUICKBOOKS_ENVIRONMENT || '').toLowerCase();
  return env === 'sandbox' ? SANDBOX_API_BASE : PROD_API_BASE;
}

function realmId(connection: Record<string, unknown>): string | null {
  const creds = (connection.credentials || {}) as Record<string, any>;
  const raw = (creds.raw || {}) as Record<string, any>;
  const cfg = (connection.connection_config || connection.metadata || {}) as Record<string, any>;
  const id =
    cfg.realmId
    || cfg.realm_id
    || raw.realmId
    || raw.realm_id
    || creds.realmId
    || process.env.QUICKBOOKS_REALM_ID
    || '';
  return String(id).trim() || null;
}

function minorVersion(): string {
  return process.env.QUICKBOOKS_MINOR_VERSION || '65';
}

function qbHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function soqlEscape(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function queryUrl(base: string, companyId: string, query: string): string {
  const params = new URLSearchParams({ query, minorversion: minorVersion() });
  return `${base}/v3/company/${encodeURIComponent(companyId)}/query?${params.toString()}`;
}

function faultMessage(data: Record<string, any>): string | null {
  const errors = data?.Fault?.Error;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first = errors[0] || {};
  return [first.Message, first.Detail].filter(Boolean).join(' — ') || 'QuickBooks Fault';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const auth = await quickbooksAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('quickbooks', actionName, timestamp);
  if (auth.kind === 'revoked') return revoked('quickbooks', actionName, timestamp, auth.detail);

  const companyId = realmId(auth.connection);
  if (!companyId) {
    return apiError(
      'quickbooks',
      actionName,
      timestamp,
      'QuickBooks realmId missing on the Nango connection (and QUICKBOOKS_REALM_ID is unset). Re-connect at /connectors.',
    );
  }

  const base = apiBase();
  const headers = qbHeaders(auth.accessToken);

  try {
    if (actionName.includes('invoice')) {
      const limit = Math.min(Number(payload.count) || 10, 50);
      const res = await fetchWithTimeout(
        queryUrl(base, companyId, `select * from Invoice maxresults ${limit}`),
        { headers },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('quickbooks', 'list_invoices', timestamp, `QuickBooks HTTP ${res.status}`);
      if (!res.ok) {
        return apiError('quickbooks', 'list_invoices', timestamp, faultMessage(data) || `QuickBooks query failed: HTTP ${res.status}`, data);
      }
      const invoices = Array.isArray(data?.QueryResponse?.Invoice) ? data.QueryResponse.Invoice : [];
      return {
        tool: 'quickbooks',
        action: 'list_invoices',
        status: 'executed' as const,
        message: `Fetched ${invoices.length} QuickBooks invoices`,
        data: { totalSize: invoices.length, invoices, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (actionName.includes('create') || actionName.includes('update')) {
      const displayName = payload.displayName || payload.name || payload.companyName;
      const email = payload.email;
      if (!displayName && !email) {
        return apiError('quickbooks', 'create_customer', timestamp, 'displayName or email is required to create a QuickBooks Customer.');
      }
      const body: Record<string, unknown> = {
        DisplayName: String(displayName || email),
      };
      if (payload.firstName || payload.givenName) body.GivenName = String(payload.firstName || payload.givenName);
      if (payload.lastName || payload.familyName) body.FamilyName = String(payload.lastName || payload.familyName);
      if (email) body.PrimaryEmailAddr = { Address: String(email) };
      if (payload.phone) body.PrimaryPhone = { FreeFormNumber: String(payload.phone) };
      const res = await fetchWithTimeout(
        `${base}/v3/company/${encodeURIComponent(companyId)}/customer?minorversion=${encodeURIComponent(minorVersion())}`,
        { method: 'POST', headers, body: JSON.stringify(body) },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('quickbooks', 'create_customer', timestamp, `QuickBooks HTTP ${res.status}`);
      if (!res.ok) {
        return apiError('quickbooks', 'create_customer', timestamp, faultMessage(data) || `QuickBooks create Customer failed: HTTP ${res.status}`, data);
      }
      const customer = data.Customer || data;
      return {
        tool: 'quickbooks',
        action: 'create_customer',
        status: 'executed' as const,
        message: `Created QuickBooks Customer ${customer.Id || ''}`.trim(),
        data: { id: customer.Id, displayName: customer.DisplayName, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    const limit = Math.min(Number(payload.count) || 10, 50);
    const email = payload.email ? ` where PrimaryEmailAddr = '${soqlEscape(String(payload.email))}'` : '';
    const res = await fetchWithTimeout(
      queryUrl(base, companyId, `select * from Customer${email} maxresults ${limit}`),
      { headers },
    );
    const data = await res.json().catch(() => ({}));
    if (isProviderUnauthorized(res.status)) return revoked('quickbooks', 'list_customers', timestamp, `QuickBooks HTTP ${res.status}`);
    if (!res.ok) {
      return apiError('quickbooks', 'list_customers', timestamp, faultMessage(data) || `QuickBooks query failed: HTTP ${res.status}`, data);
    }
    const customers = Array.isArray(data?.QueryResponse?.Customer) ? data.QueryResponse.Customer : [];
    return {
      tool: 'quickbooks',
      action: 'list_customers',
      status: 'executed' as const,
      message: `Fetched ${customers.length} QuickBooks customers`,
      data: { totalSize: customers.length, customers, httpStatus: res.status, connected: true },
      timestamp,
    };
  } catch (e: any) {
    return apiError('quickbooks', actionName, timestamp, `QuickBooks API error: ${e.message}`);
  }
}

export const quickbooks: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
