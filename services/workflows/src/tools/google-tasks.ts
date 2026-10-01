import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, nangoAuthError, notConnected, resolveGoogleAuth } from './shared.js';

const ACTIONS = ['tasks_list', 'tasks_create'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('create') || a.includes('add')) return 'draft';
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const _gAuth = await resolveGoogleAuth(orgId, 'google-tasks');
  const gToken: string | null = _gAuth.kind === 'connected' ? _gAuth.accessToken : null;
  const _gAuthErr = _gAuth.kind === 'connected' ? null : nangoAuthError('google-tasks', actionName, timestamp, _gAuth);
  if (!gToken) return _gAuthErr ?? notConnected('google-tasks', actionName, timestamp);

  try {
    const listsRes = await fetchWithTimeout('https://tasks.googleapis.com/tasks/v1/users/@me/lists', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    if (!listsRes.ok) {
      return apiError('google-tasks', actionName, timestamp, `Tasks error ${listsRes.status}: ${await listsRes.text()}`);
    }
    const listsData = await listsRes.json();
    const tasklistId = payload.tasklistId || payload.listId || listsData.items?.[0]?.id;
    if (!tasklistId) {
      return {
        tool: 'google-tasks',
        action: actionName,
        status: 'executed' as const,
        message: 'No Google Task lists found',
        data: { tasklists: [] },
        timestamp,
      };
    }

    if (actionName.includes('create') || actionName.includes('add')) {
      const title = payload.title || payload.task || payload.name;
      if (!title) {
        return apiError('google-tasks', 'tasks_create', timestamp, 'Task title is required to create a task.');
      }
      const taskBody: Record<string, any> = { title };
      if (payload.notes || payload.description) taskBody.notes = String(payload.notes || payload.description);
      if (payload.due || payload.dueDate) taskBody.due = String(payload.due || payload.dueDate);

      const createRes = await fetchWithTimeout(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(taskBody),
      });
      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        return apiError('google-tasks', 'tasks_create', timestamp, `Tasks create failed: ${createRes.status}`, createData);
      }
      return {
        tool: 'google-tasks',
        action: 'tasks_create',
        status: 'executed' as const,
        message: `✅ Created Google Task "${title}"`,
        data: { taskId: createData.id, title: createData.title, tasklistId, updated: createData.updated },
        timestamp,
      };
    }

    const itemsRes = await fetchWithTimeout(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklistId)}/tasks`, {
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
