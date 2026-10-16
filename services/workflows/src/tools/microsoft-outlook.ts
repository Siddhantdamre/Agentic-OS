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

const ACTIONS = ['list_messages', 'read_message', 'draft_email', 'draft_reply', 'send_email', 'reply_email'] as const;
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

function recipients(list: unknown) {
  return String(list || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

function messageBody(payload: Record<string, any>) {
  const to = payload.to || payload.recipient;
  return {
    subject: payload.subject || '',
    body: { contentType: 'Text', content: payload.body || payload.content || payload.text || '' },
    toRecipients: recipients(to),
    ...(payload.cc ? { ccRecipients: recipients(payload.cc) } : {}),
    ...(payload.bcc ? { bccRecipients: recipients(payload.bcc) } : {}),
  };
}

/** Graph message ids are base64-ish; anything else never reaches the URL. */
export function outlookMessagePath(payload: Record<string, any>): string | null {
  const id = String(payload.messageId ?? payload.message_id ?? payload.id ?? '').trim();
  if (!/^[A-Za-z0-9=_+\-\/]{8,512}$/.test(id)) return null;
  return `${GRAPH}/me/messages/${encodeURIComponent(id)}`;
}

/** List URL; `query` is Outlook search text (KQL), which Graph cannot combine with $orderby. */
export function outlookListUrl(count: unknown, query?: unknown): string {
  const n = Math.min(50, Math.max(1, Math.trunc(Number(count)) || 10));
  const params = new URLSearchParams({
    $top: String(n),
    $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,isDraft,isRead,conversationId',
  });
  const q = typeof query === 'string' ? query.replace(/"/g, '').trim().slice(0, 500) : '';
  if (q) params.set('$search', `"${q}"`);
  return `${GRAPH}/me/messages?${params.toString()}`;
}

const READ_BODY_MAX_CHARS = 20000;

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const auth = await outlookAuth(orgId);
  if (auth.kind === 'never-configured') return notConnected('microsoft-outlook', actionName, timestamp);
  if (auth.kind === 'revoked') return revoked('microsoft-outlook', actionName, timestamp, auth.detail);

  const token = auth.accessToken;
  try {
    if (actionName === 'read_message') {
      const path = outlookMessagePath(payload);
      if (!path) return apiError('microsoft-outlook', 'read_message', timestamp, 'A messageId from outlook_list_messages is required.');
      const res = await fetchWithTimeout(
        `${path}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,conversationId,hasAttachments,isRead`,
        { headers: { ...graphHeaders(token), Prefer: 'outlook.body-content-type="text"' } },
      );
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('microsoft-outlook', 'read_message', timestamp, `Graph HTTP ${res.status}`);
      if (!res.ok) return apiError('microsoft-outlook', 'read_message', timestamp, `Outlook read failed: HTTP ${res.status}`, data);
      const body = String(data.body?.content || '');
      return {
        tool: 'microsoft-outlook',
        action: 'read_message',
        status: 'executed' as const,
        message: `Read "${data.subject || '(No Subject)'}" from ${data.from?.emailAddress?.address || 'unknown sender'}`,
        data: {
          ...data,
          body: body.slice(0, READ_BODY_MAX_CHARS),
          bodyTruncated: body.length > READ_BODY_MAX_CHARS,
          connected: true,
        },
        timestamp,
      };
    }

    if (actionName === 'reply_email' || actionName === 'draft_reply') {
      const isDraft = actionName === 'draft_reply';
      const path = outlookMessagePath(payload);
      const comment = String(payload.body || payload.content || payload.comment || '');
      if (!path) return apiError('microsoft-outlook', actionName, timestamp, 'The messageId of the email being replied to is required.');
      if (!comment.trim()) return apiError('microsoft-outlook', actionName, timestamp, 'Reply body is required.');
      const replyAll = payload.reply_all === true || payload.replyAll === true;
      const verb = `${isDraft ? 'createReply' : 'reply'}${replyAll ? 'All' : ''}`;
      const extra = payload.to || payload.cc
        ? {
            message: {
              ...(payload.to ? { toRecipients: recipients(payload.to) } : {}),
              ...(payload.cc ? { ccRecipients: recipients(payload.cc) } : {}),
            },
          }
        : {};
      const res = await fetchWithTimeout(`${path}/${verb}`, {
        method: 'POST',
        headers: graphHeaders(token),
        body: JSON.stringify({ comment, ...extra }),
      });
      const data = await res.json().catch(() => ({}));
      if (isProviderUnauthorized(res.status)) return revoked('microsoft-outlook', actionName, timestamp, `Graph HTTP ${res.status}`);
      if (!res.ok) return apiError('microsoft-outlook', actionName, timestamp, `Outlook ${isDraft ? 'reply draft' : 'reply'} failed: HTTP ${res.status}`, data);
      return {
        tool: 'microsoft-outlook',
        action: actionName,
        status: 'executed' as const,
        message: isDraft
          ? `Reply${replyAll ? '-all' : ''} draft saved in Outlook — nothing has been sent yet`
          : `Replied${replyAll ? ' to all' : ''} in the Outlook thread`,
        data: { ...(isDraft ? { draftId: data.id } : {}), replyAll, httpStatus: res.status, connected: true },
        timestamp,
      };
    }

    if (actionName.includes('list') || actionName.includes('fetch') || actionName.includes('read')) {
      const query = typeof payload.query === 'string' ? payload.query : '';
      const res = await fetchWithTimeout(outlookListUrl(payload.count, query), { headers: graphHeaders(token) });
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
