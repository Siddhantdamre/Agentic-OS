import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['send_channel_message'] as const;

function riskFor(_action: string): ToolRisk {
  return 'send';
}

async function execute(ctx: ToolActionContext) {
  const { payload, orgId, timestamp } = ctx;
  const slackConnId = `${orgId}_slack`;
  const slackToken = await getNangoAccessToken(slackConnId, 'slack');
  if (slackToken) {
    try {
      const channel = payload.channel || '#general';
      const text = payload.message || payload.text || 'Notification from DareX AI';
      const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, text }),
      });
      if (slackRes.ok) {
        const slackData = await slackRes.json();
        if (slackData.ok) {
          return {
            tool: 'slack',
            action: 'send_channel_message',
            status: 'executed' as const,
            message: `✅ Sent message to ${channel} via Slack API`,
            data: { channel, ts: slackData.ts, messageSent: true },
            timestamp,
          };
        }
        return {
          tool: 'slack', action: 'send_channel_message', status: 'error' as const,
          message: `Slack API error: ${slackData.error}`, data: null, timestamp,
        };
      }
    } catch (e: any) {
      console.error('[Slack] API error:', e.message);
    }
  }
  return notConnected('slack', 'send_channel_message', timestamp);
}

export const slack: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
