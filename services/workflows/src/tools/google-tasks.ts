import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['tasks_list'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gConnId = `${orgId}_google-tasks`;
  let gToken: string | null = null;
  for (const providerKey of ['google-tasks', 'google']) {
    gToken = await getNangoAccessToken(gConnId, providerKey);
    if (gToken) break;
  }
  if (!gToken) return notConnected('google-tasks', actionName, timestamp);

  try {
    const listsRes = await fetchWithTimeout('https://tasks.googleapis.com/v1/users/@me/lists', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    if (!listsRes.ok) {
      return apiError('google-tasks', 'tasks_list', timestamp, `Tasks error ${listsRes.status}: ${await listsRes.text()}`);
    }
    const listsData = await listsRes.json();
    const tasklistId = payload.tasklistId || payload.listId || listsData.items?.[0]?.id;
    if (!tasklistId) {
      return {
        tool: 'google-tasks',
        action: 'tasks_list',
        status: 'executed' as const,
        message: 'No Google Task lists found',
        data: { tasklists: [] },
        timestamp,
      };
    }
    const itemsRes = await fetchWithTimeout(`https://tasks.googleapis.com/v1/lists/${encodeURIComponent(tasklistId)}/tasks`, {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    if (!itemsRes.ok) {
      return apiError('google-tasks', 'tasks_list', timestamp, `Tasks items error ${itemsRes.status}: ${await itemsRes.text()}`);
    }
    const itemsData = await itemsRes.json();
    return {
      tool: 'google-tasks',
      action: 'tasks_list',
      status: 'executed' as const,
      message: `Fetched ${itemsData.items?.length || 0} tasks from list ${tasklistId}`,
      data: { tasklistId, tasklists: listsData.items || [], tasks: itemsData.items || [] },
      timestamp,
    };
  } catch (e: any) {
    console.error('[google-tasks] API error:', e.message);
    return { tool: 'google-tasks', action: actionName, status: 'error' as const, message: `google-tasks request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleTasks: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
