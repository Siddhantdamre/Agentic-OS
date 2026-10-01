import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, nangoAuthError, notConnected, resolveNangoAuth, fetchWithTimeout, withOrgScopedClient } from './shared.js';

const ACTIONS = ['send_channel_message', 'read_channel', 'post_decision_card'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('read')) return 'read';
  return 'send';
}

/**
 * Explicit channel, else the org's configured ops channel. Never a hardcoded
 * default: a garbled call must not post to #general (RT-B06).
 */
async function slackChannel(payload: Record<string, any>, orgId: string): Promise<string | null> {
  const explicit = String(payload.channel || payload.channel_id || '').trim();
  if (explicit) return explicit;
  return withOrgScopedClient(orgId, async (client) => {
    const res = await client.query<{ channel: string | null }>(
      `SELECT COALESCE(NULLIF(meta->>'ops_slack_channel', ''), NULLIF(meta->>'manager_slack_channel', '')) AS channel
         FROM orgs WHERE id = $1`,
      [orgId],
    );
    return res.rows[0]?.channel || null;
  });
}

async function execute(ctx: ToolActionContext) {
  const { payload, orgId, timestamp, actionName } = ctx;
  const slackConnId = `${orgId}_slack`;
  const _slackAuth = await resolveNangoAuth(slackConnId, 'slack');
  const slackToken = _slackAuth.kind === 'connected' ? _slackAuth.accessToken : null;
  const _slackAuthErr = _slackAuth.kind === 'connected' ? null : nangoAuthError('slack', actionName, timestamp, _slackAuth);
  if (!slackToken) return _slackAuthErr ?? notConnected('slack', actionName, timestamp);

  try {
    const channel = await slackChannel(payload, orgId);
    if (!channel) {
      return apiError('slack', actionName, timestamp, 'channel is required (no ops_slack_channel configured for this workspace)');
    }

    if (actionName.includes('read')) {
      const res = await fetchWithTimeout(
        `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=20`,
        { headers: { Authorization: `Bearer ${slackToken}` } }
      );
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        return {
          tool: 'slack',
          action: 'read_channel',
          status: 'error' as const,
          message: `Slack API error: ${data.error || res.status}`,
          data: null,
          timestamp,
        };
      }
      return {
        tool: 'slack',
        action: 'read_channel',
        status: 'executed' as const,
        message: `Read ${Array.isArray(data.messages) ? data.messages.length : 0} messages from ${channel}`,
        data: { channel, messages: data.messages || [] },
        timestamp,
      };
    }

    if (actionName.includes('decision') || actionName.includes('card')) {
      const workItemId = payload.workItemId || payload.work_item_id;
      if (!workItemId) {
        return apiError('slack', 'post_decision_card', timestamp, 'workItemId is required');
      }
      const title = payload.title || payload.summary || 'Decision needed';
      const body = payload.message || payload.text || payload.body || 'Approve or reject this action.';
      const slackRes = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          text: String(title),
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: String(title).slice(0, 150) },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: String(body).slice(0, 2900) },
            },
            {
              type: 'actions',
              block_id: `work_item:${workItemId}`,
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Approve' },
                  style: 'primary',
                  action_id: 'work_item_approve',
                  value: JSON.stringify({ workItemId, decision: 'approve', orgId }),
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Reject' },
                  style: 'danger',
                  action_id: 'work_item_reject',
                  value: JSON.stringify({ workItemId, decision: 'reject', orgId }),
                },
              ],
            },
          ],
        }),
      });
      const slackData = await slackRes.json().catch(() => ({}));
      if (!slackData.ok) {
        return {
          tool: 'slack',
          action: 'post_decision_card',
          status: 'error' as const,
          message: `Slack API error: ${slackData.error || slackRes.status}`,
          data: null,
          timestamp,
        };
      }
      return {
        tool: 'slack',
        action: 'post_decision_card',
        status: 'executed' as const,
        message: `Posted decision card to ${channel}`,
        data: { channel, ts: slackData.ts, workItemId, cardPosted: true },
        timestamp,
      };
    }

    const text = payload.message || payload.text || 'Notification from DareX AI';
    const slackRes = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text }),
    });
    const slackData = await slackRes.json().catch(() => ({}));
    if (!slackData.ok) {
      return {
        tool: 'slack',
        action: 'send_channel_message',
        status: 'error' as const,
        message: `Slack API error: ${slackData.error || slackRes.status}`,
        data: null,
        timestamp,
      };
    }
    return {
      tool: 'slack',
      action: 'send_channel_message',
      status: 'executed' as const,
      message: `Sent message to ${channel} via Slack API`,
      data: { channel, ts: slackData.ts, messageSent: true },
      timestamp,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Slack] API error:', message);
    return notConnected('slack', actionName, timestamp);
  }
}

export const slack: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
