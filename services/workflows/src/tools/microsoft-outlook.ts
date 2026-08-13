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

const ACTIONS = ['list_messages', 'draft_email', 'send_email'] as const;
const GRAPH = 'https://graph.microsoft.com/v1.0';

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('draft') || a.includes('compose')) return 'draft';
  if (a.includes('list') || a.includes('fetch') || a.includes('read')) return 'read';
  return 'send';
}

async function outlookAuth(orgId: string): Promise<NangoAuthState> {
  const specific = await resolveNangoAuth(`${orgId}_microsoft-outlook`, ['microsoft-outlook', 'microsoft']);
  if (specific.kind === 'connected') return specific;
  const umbrella = await resolveNangoAuth(`${orgId}_microsoft`, ['microsoft', 'microsoft-outlook']);
  if (umbrella.kind === 'connected') return umbrella;
  if (specific.kind === 'revoked') return specific;
  if (umbrella.kind === 'revoked') return umbrella;
  return { kind: 'never-configured' };
}

function graphHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function messageBody(payload: Record<string, any>) {
  const to = payload.to || payload.recipient;
  return {
    subject: payload.subject || '',
    body: { contentType: 'Text', content: payload.body || payload.content || payload.text || '' },
    toRecipients: to
      ? [{ emailAddress: { address: String(to) } }]
      : [],
    ...(payload.cc
      ? { ccRecipients: String(payload.cc).split(',').map((a: string) => ({ emailAddress: { address: a.trim() } })) }
      : {}),
  };
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const auth = await outlookAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('microsoft-outlook', actionName, timestamp);
  if (auth.kind === 'revoked') return revoked('microsoft-outlook', actionName, timestamp, auth.detail);

  const token = auth.accessToken;
  try {
    if (actionName.includes('list') || actionName.includes('fetch') || actionName.includes('read')) {
      const count = Math.min(Number(payload.count) || 10, 50);
      const res = await fetchWithTimeout(
        `${GRAPH}/me/messages?$top=${count}&$select=id,subject,from,receivedDateTime,bodyPreview,isDraft,isRead`,
        { headers: graphHeaders(token) },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('microsoft-outlook', 'list_messages', timestamp, `Graph HTTP ${res.status}`);
      if (!res.ok) return apiError('microsoft-outlook', 'list_messages', timestamp, `Outlook list failed: HTTP ${res.status}`, data);
      const messages = Array.isArray(data.value) ? data.value : [];
      return {
        tool: 'microsoft-outlook',
        action: 'list_messages',
        status: 'executed' as const,
        message: `Fetched ${messages.length} messages from Outlook`,
        data: { totalFetched: messages.length, messages, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (actionName.includes('draft') || actionName.includes('compose')) {
      const to = payload.to || payload.recipient;
      if (!to) return apiError('microsoft-outlook', 'draft_email', timestamp, 'Recipient email (to/recipient) is required.');
      if (!payload.subject) return apiError('microsoft-outlook', 'draft_email', timestamp, 'Email subject is required.');
      const res = await fetchWithTimeout(`${GRAPH}/me/messages`, {
        method: 'POST',
        headers: graphHeaders(token),
        body: JSON.stringify(messageBody(payload)),
      });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('microsoft-outlook', 'draft_email', timestamp, `Graph HTTP ${res.status}`);
      if (!res.ok) return apiError('microsoft-outlook', 'draft_email', timestamp, `Outlook draft failed: HTTP ${res.status}`, data);
      return {
        tool: 'microsoft-outlook',
        action: 'draft_email',
        status: 'executed' as const,
        message: `Draft saved to Outlook for ${to} — nothing has been sent yet`,
        data: { draftId: data.id, recipient: to, subject: payload.subject, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    const to = payload.to || payload.recipient;
    if (!to) return apiError('microsoft-outlook', 'send_email', timestamp, 'Recipient email (to/recipient) is required.');
    if (!payload.subject) return apiError('microsoft-outlook', 'send_email', timestamp, 'Email subject is required.');
    const res = await fetchWithTimeout(`${GRAPH}/me/sendMail`, {
      method: 'POST',
      headers: graphHeaders(token),
      body: JSON.stringify({ message: messageBody(payload), saveToSentItems: true }),
    });
    const errBody = res.ok ? {} : await res.json().catch(() => ({}));
    if (isProviderUnauthorized(res.status)) return revoked('microsoft-outlook', 'send_email', timestamp, `Graph HTTP ${res.status}`);
    if (!res.ok) return apiError('microsoft-outlook', 'send_email', timestamp, `Outlook send failed: HTTP ${res.status}`, errBody);
    return {
      tool: 'microsoft-outlook',
      action: 'send_email',
      status: 'executed' as const,
      message: `Sent email to ${to} via Microsoft Graph`,
      data: { recipient: to, subject: payload.subject, httpStatus: res.status, connected: true },
      timestamp,
    };
  } catch (e: any) {
    return apiError('microsoft-outlook', actionName, timestamp, `Outlook API error: ${e.message}`);
  }
}

export const microsoftOutlook: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
