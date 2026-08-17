import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['chat_list_spaces', 'chat_send_message'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('send') || a.includes('message')) return 'send';
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gConnId = `${orgId}_google-chat`;
  let gToken: string | null = null;
  for (const providerKey of ['google-chat', 'google']) {
    gToken = await getNangoAccessToken(gConnId, providerKey);
    if (gToken) break;
  }
  if (!gToken) return notConnected('google-chat', actionName, timestamp);

  try {
    if (actionName.includes('send') || actionName.includes('message')) {
      const space = payload.space || payload.spaceId;
      const text = payload.text || payload.message || payload.body;
      if (!space) return apiError('google-chat', 'chat_send_message', timestamp, 'space (spaces/xxx) is required to send a Chat message.');
      if (!text) return apiError('google-chat', 'chat_send_message', timestamp, 'text is required to send a Chat message.');
      const sendRes = await fetchWithTimeout(`https://chat.googleapis.com/v1/${space}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const sendData = await sendRes.json().catch(() => ({}));
      if (!sendRes.ok) return apiError('google-chat', 'chat_send_message', timestamp, `Chat send failed: ${sendRes.status}`, sendData);
      return { tool: 'google-chat', action: 'chat_send_message', status: 'executed' as const, message: `Sent Chat message to ${space}`, data: sendData, timestamp };
    }
    const listRes = await fetchWithTimeout('https://chat.googleapis.com/v1/spaces', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    const listData = await listRes.json().catch(() => ({}));
    if (!listRes.ok) return apiError('google-chat', 'chat_list_spaces', timestamp, `Chat list failed: ${listRes.status}`, listData);
    return { tool: 'google-chat', action: 'chat_list_spaces', status: 'executed' as const, message: `Listed ${listData.spaces?.length || 0} Chat spaces`, data: { spaces: listData.spaces || [] }, timestamp };
  } catch (e: any) {
    console.error('[google-chat] API error:', e.message);
    return { tool: 'google-chat', action: actionName, status: 'error' as const, message: `google-chat request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleChat: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
