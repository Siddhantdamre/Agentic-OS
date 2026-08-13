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

const ACTIONS = ['list_envelopes', 'create_envelope', 'send_envelope'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('send') || a.includes('sign')) return 'sign';
  if (a.includes('list') || a.includes('fetch') || a.includes('read') || a.includes('status')) return 'read';
  return 'draft';
}

async function docusignAuth(orgId: string): Promise<NangoAuthState> {
  return resolveNangoAuth(`${orgId}_docusign`, ['docusign']);
}

function userinfoHost(): string {
  return process.env.DOCUSIGN_OAUTH_BASE_URL || 'https://account.docusign.com';
}

interface DocusignAccount {
  accountId: string;
  baseUri: string;
}

async function resolveAccount(token: string, payload: Record<string, any>): Promise<DocusignAccount | { error: 'revoked' | 'missing'; detail?: string }> {
  const res = await fetchWithTimeout(`${userinfoHost()}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (isProviderUnauthorized(res.status)) return { error: 'revoked', detail: `DocuSign userinfo HTTP ${res.status}` };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { error: 'missing', detail: `DocuSign userinfo failed: HTTP ${res.status}` };
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const wanted = payload.accountId || payload.account_id;
  const match = wanted
    ? accounts.find((a: any) => a.account_id === wanted)
    : accounts.find((a: any) => a.is_default) || accounts[0];
  if (!match?.account_id || !match?.base_uri) return { error: 'missing', detail: 'DocuSign account id / base URI missing from userinfo' };
  return { accountId: String(match.account_id), baseUri: String(match.base_uri).replace(/\/+$/, '') };
}

function signerList(payload: Record<string, any>): Array<{ email: string; name: string; recipientId: string; routingOrder?: string }> {
  if (Array.isArray(payload.signers) && payload.signers.length > 0) {
    return payload.signers.map((s: any, i: number) => ({
      email: String(s.email || s.emailAddress || ''),
      name: String(s.name || s.fullName || s.email || `Signer ${i + 1}`),
      recipientId: String(s.recipientId || i + 1),
      routingOrder: String(s.routingOrder || i + 1),
    })).filter((s: { email: string }) => s.email);
  }
  const email = payload.signerEmail || payload.email || payload.recipient;
  if (!email) return [];
  return [{
    email: String(email),
    name: String(payload.signerName || payload.name || email),
    recipientId: '1',
    routingOrder: '1',
  }];
}

function documentFromPayload(payload: Record<string, any>): { documentBase64: string; name: string; fileExtension: string; documentId: string } | null {
  if (payload.documentBase64) {
    return {
      documentBase64: String(payload.documentBase64),
      name: String(payload.documentName || payload.fileName || 'Agreement.pdf'),
      fileExtension: String(payload.fileExtension || 'pdf'),
      documentId: '1',
    };
  }
  const text = payload.documentText || payload.body || payload.content;
  if (typeof text === 'string' && text.length > 0) {
    return {
      documentBase64: Buffer.from(text, 'utf8').toString('base64'),
      name: String(payload.documentName || 'Agreement.txt'),
      fileExtension: 'txt',
      documentId: '1',
    };
  }
  return null;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const auth = await docusignAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('docusign', actionName, timestamp);
  if (auth.kind === 'revoked') return revoked('docusign', actionName, timestamp, auth.detail);

  const account = await resolveAccount(auth.accessToken, payload);
  if ('error' in account) {
    if (account.error === 'revoked') return revoked('docusign', actionName, timestamp, account.detail);
    return apiError('docusign', actionName, timestamp, account.detail || 'Could not resolve DocuSign account.');
  }
  const apiBase = `${account.baseUri}/restapi/v2.1/accounts/${account.accountId}`;
  const headers = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' };

  try {
    if (actionName.includes('list') || actionName.includes('fetch') || actionName.includes('status')) {
      const fromDate = payload.fromDate || new Date(Date.now() - 30 * 86400000).toISOString();
      const res = await fetchWithTimeout(
        `${apiBase}/envelopes?from_date=${encodeURIComponent(fromDate)}`,
        { headers },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('docusign', 'list_envelopes', timestamp, `DocuSign HTTP ${res.status}`);
      if (!res.ok) return apiError('docusign', 'list_envelopes', timestamp, `DocuSign list failed: HTTP ${res.status}`, data);
      const envelopes = Array.isArray(data.envelopes) ? data.envelopes : [];
      return {
        tool: 'docusign',
        action: 'list_envelopes',
        status: 'executed' as const,
        message: `Fetched ${envelopes.length} DocuSign envelopes`,
        data: { resultSetSize: data.resultSetSize ?? envelopes.length, envelopes, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    const sendNow = actionName.includes('send') || actionName.includes('sign');
    const signers = signerList(payload);
    if (signers.length === 0) {
      return apiError('docusign', sendNow ? 'send_envelope' : 'create_envelope', timestamp, 'At least one signer email is required.');
    }
    const document = documentFromPayload(payload);
    if (!document) {
      return apiError(
        'docusign',
        sendNow ? 'send_envelope' : 'create_envelope',
        timestamp,
        'A document is required (documentBase64 or documentText). Darex will not invent contract contents.',
      );
    }
    const emailSubject = payload.emailSubject || payload.subject || 'Please sign this document';
    const res = await fetchWithTimeout(`${apiBase}/envelopes`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        emailSubject,
        status: sendNow ? 'sent' : 'created',
        documents: [document],
        recipients: { signers },
      }),
    });
    const data = await res.json().catch(() => ({}));
    const action = sendNow ? 'send_envelope' : 'create_envelope';
    if (isProviderUnauthorized(res.status)) return revoked('docusign', action, timestamp, `DocuSign HTTP ${res.status}`);
    if (!res.ok) return apiError('docusign', action, timestamp, `DocuSign ${action} failed: HTTP ${res.status}`, data);
    return {
      tool: 'docusign',
      action,
      status: 'executed' as const,
      message: sendNow
        ? `Sent DocuSign envelope ${data.envelopeId || ''} for signature`.trim()
        : `Created DocuSign draft envelope ${data.envelopeId || ''} — not sent`.trim(),
      data: {
        envelopeId: data.envelopeId,
        status: data.status,
        uri: data.uri,
        httpStatus: res.status,
        connected: true,
      },
      timestamp,
    };
  } catch (e: any) {
    return apiError('docusign', actionName, timestamp, `DocuSign API error: ${e.message}`);
  }
}

export const docusign: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
