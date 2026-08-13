import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['fetch_conversations', 'reply_conversation', 'create_conversation'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('reply') || a.includes('comment') || a.includes('create')) return 'send';
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const intercomConnId = `${orgId}_intercom`;
  const intercomToken = await getNangoAccessToken(intercomConnId, 'intercom');
  if (!intercomToken) return notConnected('intercom', actionName, timestamp);
  const intercomHeaders = {
    Authorization: `Bearer ${intercomToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Intercom-Version': '2.11',
  };
  try {
    if (actionName.includes('reply') || actionName.includes('comment')) {
      const conversationId = payload.conversationId || payload.id;
      const body = payload.body || payload.message || payload.text;
      if (!conversationId) return apiError('intercom', 'reply_conversation', timestamp, 'conversationId is required to reply.');
      if (!body) return apiError('intercom', 'reply_conversation', timestamp, 'message body is required to reply.');
      const meRes = await fetchWithTimeout('https://api.intercom.io/me', { headers: intercomHeaders });
      const me = await meRes.json().catch(() => ({}));
      const adminId = payload.adminId || me?.id;
      if (!adminId) return apiError('intercom', 'reply_conversation', timestamp, 'Could not resolve Intercom admin id for the connected app.');
      const replyRes = await fetchWithTimeout(`https://api.intercom.io/conversations/${conversationId}/reply`, {
        method: 'POST',
        headers: intercomHeaders,
        body: JSON.stringify({ type: 'admin', message_type: 'comment', admin_id: adminId, body }),
      });
      const replyData = await replyRes.json().catch(() => ({}));
      if (!replyRes.ok) {
        return apiError('intercom', 'reply_conversation', timestamp, `Intercom reply failed: ${replyRes.status}`, replyData);
      }
      return { tool: 'intercom', action: 'reply_conversation', status: 'executed' as const, message: `Replied to Intercom conversation ${conversationId}`, data: replyData, timestamp };
    }
    if (actionName.includes('create')) {
      const body = payload.body || payload.message || payload.text;
      if (!body) return apiError('intercom', 'create_conversation', timestamp, 'message body is required to create a conversation.');
      const meRes = await fetchWithTimeout('https://api.intercom.io/me', { headers: intercomHeaders });
      const me = await meRes.json().catch(() => ({}));
      const adminId = payload.adminId || me?.id;
      const fromUserId = payload.userId || payload.contactId;
      if (!fromUserId && !adminId) {
        return apiError('intercom', 'create_conversation', timestamp, 'userId (contact) or a resolvable admin id is required to create a conversation.');
      }
      const createRes = await fetchWithTimeout('https://api.intercom.io/conversations', {
        method: 'POST',
        headers: intercomHeaders,
        body: JSON.stringify({
          from: fromUserId ? { type: 'user', id: fromUserId } : { type: 'admin', id: adminId },
          body,
        }),
      });
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        return apiError('intercom', 'create_conversation', timestamp, `Intercom create failed: ${createRes.status}`, createData);
      }
      return { tool: 'intercom', action: 'create_conversation', status: 'executed' as const, message: 'Created Intercom conversation', data: createData, timestamp };
    }
    const intercomRes = await fetchWithTimeout('https://api.intercom.io/conversations?state=open&per_page=10', { headers: intercomHeaders });
    const intercomData = await intercomRes.json().catch(() => ({}));
    if (!intercomRes.ok) {
      return apiError('intercom', 'fetch_conversations', timestamp, `Intercom fetch failed: ${intercomRes.status}`, intercomData);
    }
    const conversations = intercomData.conversations || [];
    return {
      tool: 'intercom',
      action: 'fetch_conversations',
      status: 'executed' as const,
      message: `Synced ${conversations.length} live conversations from Intercom`,
      data: { openConversations: conversations.length, conversations: conversations.slice(0, 5) },
      timestamp,
    };
  } catch (e: any) {
    return apiError('intercom', actionName, timestamp, `Intercom API error: ${e.message}`);
  }
}

export const intercom: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
