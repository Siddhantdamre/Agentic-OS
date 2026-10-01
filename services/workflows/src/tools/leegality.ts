import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import {
  apiError,
  confirmFromRisk,
  fetchWithTimeout,
  isProviderUnauthorized,
  notConnected,
  resolveNangoAuth,
  revoked,
  withOrgScopedClient,
} from './shared.js';

const ACTIONS = ['list_documents', 'create_document', 'send_document'] as const;
const DEFAULT_API_BASE = 'https://app1.leegality.com/api';

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('list') || a.includes('fetch') || a.includes('read') || a.includes('status')) return 'read';
  return 'sign';
}

interface LeegalityCreds {
  token: string;
  apiBase: string;
  profileId: string;
  source: 'nango' | 'channel' | 'env';
}

function pickToken(bag: Record<string, any>): string {
  return String(
    bag.authToken
    || bag.auth_token
    || bag.apiToken
    || bag.api_token
    || bag.token
    || '',
  );
}

async function leegalityCreds(orgId: string): Promise<LeegalityCreds | { kind: 'never-configured' } | { kind: 'revoked'; detail: string }> {
  const nango = await resolveNangoAuth(`${orgId}_leegality`, ['leegality']);
  if (nango.kind === 'revoked') return nango;
  if (nango.kind === 'connected') {
    const creds = (nango.connection.credentials || {}) as Record<string, any>;
    const raw = (creds.raw || {}) as Record<string, any>;
    const cfg = (nango.connection.connection_config || nango.connection.metadata || {}) as Record<string, any>;
    const token = pickToken({ ...cfg, ...raw, ...creds, token: nango.accessToken });
    if (token) {
      return {
        token,
        apiBase: String(cfg.apiBaseUrl || cfg.api_base || process.env.LEEGALITY_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, ''),
        profileId: String(cfg.profileId || cfg.profile_id || process.env.LEEGALITY_PROFILE_ID || ''),
        source: 'nango',
      };
    }
  }

  let meta: Record<string, any> = {};
  try {
    await withOrgScopedClient(orgId, async (client) => {
      const chan = await client.query(
        `SELECT meta FROM channels WHERE org_id = $1 AND channel_type = 'leegality' AND status IN ('connected', 'active')`,
        [orgId],
      );
      meta = chan.rows[0]?.meta || {};
    });
  } catch (err: any) {
    console.warn(`[leegality] channel lookup failed for ${orgId}:`, err?.message);
  }
  const channelToken = pickToken(meta);
  if (channelToken) {
    return {
      token: channelToken,
      apiBase: String(meta.apiBaseUrl || meta.api_base || process.env.LEEGALITY_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, ''),
      profileId: String(meta.profileId || meta.profile_id || process.env.LEEGALITY_PROFILE_ID || ''),
      source: 'channel',
    };
  }

  const envToken = process.env.LEEGALITY_API_TOKEN || '';
  if (envToken) {
    return {
      token: envToken,
      apiBase: String(process.env.LEEGALITY_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, ''),
      profileId: String(process.env.LEEGALITY_PROFILE_ID || ''),
      source: 'env',
    };
  }
  return { kind: 'never-configured' };
}

function inviteeList(payload: Record<string, any>): Array<{ name: string; email?: string; phone?: string }> {
  if (Array.isArray(payload.invitees) && payload.invitees.length > 0) {
    return payload.invitees.map((s: any, i: number) => ({
      name: String(s.name || s.fullName || s.email || `Invitee ${i + 1}`),
      email: s.email || s.emailAddress ? String(s.email || s.emailAddress) : undefined,
      phone: s.phone || s.mobile ? String(s.phone || s.mobile) : undefined,
    })).filter((s: { email?: string; phone?: string }) => s.email || s.phone);
  }
  const email = payload.signerEmail || payload.email || payload.recipient;
  const phone = payload.signerPhone || payload.phone || payload.mobile;
  if (!email && !phone) return [];
  return [{
    name: String(payload.signerName || payload.name || email || phone),
    email: email ? String(email) : undefined,
    phone: phone ? String(phone) : undefined,
  }];
}

function documentFromPayload(payload: Record<string, any>): { name: string; file: string } | null {
  if (payload.documentBase64 || payload.file) {
    return {
      name: String(payload.documentName || payload.fileName || 'Agreement.pdf'),
      file: String(payload.documentBase64 || payload.file),
    };
  }
  const text = payload.documentText || payload.body || payload.content;
  if (typeof text === 'string' && text.length > 0) {
    return {
      name: String(payload.documentName || 'Agreement.txt'),
      file: Buffer.from(text, 'utf8').toString('base64'),
    };
  }
  return null;
}

function documentsFromList(data: Record<string, any>): unknown[] {
  if (Array.isArray(data.documents)) return data.documents;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.list)) return data.list;
  if (data.data && Array.isArray(data.data.documents)) return data.data.documents;
  if (data.data && Array.isArray(data.data.list)) return data.data.list;
  return [];
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const creds = await leegalityCreds(orgId);
  if ('kind' in creds && creds.kind === 'never-configured') return notConnected('leegality', actionName, timestamp);
  if ('kind' in creds && creds.kind === 'revoked') return revoked('leegality', actionName, timestamp, creds.detail);

  const headers = {
    'X-Auth-Token': creds.token,
    'Content-Type': 'application/json',
  };
  const apiBase = creds.apiBase;

  try {
    if (actionName.includes('list') || actionName.includes('fetch') || actionName.includes('status')) {
      const limit = Math.min(Number(payload.count) || 10, 50);
      const params = new URLSearchParams({ limit: String(limit) });
      if (payload.irn) params.set('irn', String(payload.irn));
      if (payload.search) params.set('search', String(payload.search));
      const res = await fetchWithTimeout(`${apiBase}/v3.0/sign/request/list?${params.toString()}`, { headers });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('leegality', 'list_documents', timestamp, `Leegality HTTP ${res.status}`);
      if (!res.ok) return apiError('leegality', 'list_documents', timestamp, `Leegality list failed: HTTP ${res.status}`, data);
      if (data.status === 0) {
        return apiError('leegality', 'list_documents', timestamp, `Leegality list failed: ${data.message || 'status 0'}`, data);
      }
      const documents = documentsFromList(data);
      return {
        tool: 'leegality',
        action: 'list_documents',
        status: 'executed' as const,
        message: `Fetched ${documents.length} Leegality documents`,
        data: { totalSize: documents.length, documents, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    const sendNow = actionName.includes('send') || actionName.includes('sign');
    const action = sendNow ? 'send_document' : 'create_document';
    const invitees = inviteeList(payload);
    if (invitees.length === 0) {
      return apiError('leegality', action, timestamp, 'At least one invitee email or phone is required.');
    }
    const document = documentFromPayload(payload);
    if (!document) {
      return apiError(
        'leegality',
        action,
        timestamp,
        'A document is required (documentBase64 or documentText). Darex will not invent contract contents.',
      );
    }
    const profileId = payload.profileId || payload.profile_id || creds.profileId;
    if (!profileId) {
      return apiError(
        'leegality',
        action,
        timestamp,
        'profileId (Leegality workflow id) is required. Set it on the connector, LEEGALITY_PROFILE_ID, or the tool payload.',
      );
    }

    const res = await fetchWithTimeout(`${apiBase}/v3.0/sign/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profileId: String(profileId),
        file: document,
        invitees,
        irn: payload.irn || payload.reference || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (isProviderUnauthorized(res.status)) return revoked('leegality', action, timestamp, `Leegality HTTP ${res.status}`);
    if (!res.ok) return apiError('leegality', action, timestamp, `Leegality ${action} failed: HTTP ${res.status}`, data);
    if (data.status === 0) {
      return apiError('leegality', action, timestamp, `Leegality ${action} failed: ${data.message || 'status 0'}`, data);
    }
    const created = data.data || data;
    return {
      tool: 'leegality',
      action,
      status: 'executed' as const,
      message: sendNow
        ? `Sent Leegality e-sign request ${created.documentId || ''}`.trim()
        : `Created Leegality e-sign request ${created.documentId || ''}`.trim(),
      data: {
        documentId: created.documentId,
        irn: created.irn,
        invitees: created.invitees,
        expiryDate: created.expiryDate,
        httpStatus: res.status,
        connected: true,
      },
      timestamp,
    };
  } catch (e: any) {
    return apiError('leegality', actionName, timestamp, `Leegality API error: ${e.message}`);
  }
}

export const leegality: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
