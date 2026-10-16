import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, nangoAuthError, notConnected, resolveNangoAuth, fetchWithTimeout, withOrgScopedClient } from './shared.js';

const ACTIONS = ['send_channel_message', 'send_reply', 'read_channel', 'read_thread', 'list_channels', 'post_decision_card'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('read') || a.includes('list')) return 'read';
  return 'send';
}

/** Slack message timestamps look like "1712345678.123456". */
export function slackTs(v: unknown): string | null {
  const ts = String(v ?? '').trim();
  return /^\d{9,11}\.\d{1,6}$/.test(ts) ? ts : null;
}

async function slackApi(token: string, method: string, params: Record<string, string>) {
  const res = await fetchWithTimeout(`https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, data: await res.json().catch(() => ({} as any)) };
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
    if (actionName === 'list_channels') {
      const { status, data } = await slackApi(slackToken, 'conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '200',
      });
      if (!data.ok) return apiError('slack', 'list_channels', timestamp, `Slack API error: ${data.error || status}`);
      const channels = (Array.isArray(data.channels) ? data.channels : []).map((c: any) => ({
        id: c.id,
        name: c.name,
        isPrivate: Boolean(c.is_private),
        isMember: Boolean(c.is_member),
        topic: c.topic?.value || '',
      }));
      return {
        tool: 'slack',
        action: 'list_channels',
        status: 'executed' as const,
        message: `Found ${channels.length} Slack channels`,
        data: { channels },
        timestamp,
      };
    }

    const channel = await slackChannel(payload, orgId);
    if (!channel) {
      return apiError('slack', actionName, timestamp, 'channel is required (no ops_slack_channel configured for this workspace)');
    }

    if (actionName === 'read_thread' || actionName === 'send_reply') {
      const threadTs = slackTs(payload.thread_ts ?? payload.threadTs ?? payload.ts);
      if (!threadTs) return apiError('slack', actionName, timestamp, 'thread_ts (the parent message ts from slack_read_channel) is required.');
      if (!String(payload.channel || payload.channel_id || '').trim()) {
        return apiError('slack', actionName, timestamp, 'channel is required: the channel the thread is in.');
      }
      if (actionName === 'read_thread') {
        const { status, data } = await slackApi(slackToken, 'conversations.replies', { channel, ts: threadTs, limit: '100' });
        if (!data.ok) return apiError('slack', 'read_thread', timestamp, `Slack API error: ${data.error || status}`);
        const messages = Array.isArray(data.messages) ? data.messages : [];
        return {
          tool: 'slack',
          action: 'read_thread',
          status: 'executed' as const,
          message: `Read ${messages.length} messages from the thread in ${channel}`,
          data: { channel, threadTs, messages },
          timestamp,
        };
      }
      const text = String(payload.message || payload.text || '').trim();
      if (!text) return apiError('slack', 'send_reply', timestamp, 'message is required.');
      const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, text, thread_ts: threadTs }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) return apiError('slack', 'send_reply', timestamp, `Slack API error: ${data.error || res.status}`);
      return {
        tool: 'slack',
        action: 'send_reply',
        status: 'executed' as const,
        message: `Replied in the thread in ${channel}`,
        data: { channel, threadTs, ts: data.ts, messageSent: true },
        timestamp,
      };
    }

    if (actionName.includes('read')) {
      const limit = String(Math.min(100, Math.max(1, Math.trunc(Number(payload.limit ?? payload.count)) || 20)));
      const res = await fetchWithTimeout(
        `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=${limit}`,
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
