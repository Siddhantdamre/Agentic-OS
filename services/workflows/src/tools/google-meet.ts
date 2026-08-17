import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['meet_create_space', 'meet_get_space'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('get') || a.includes('fetch')) return 'read';
  return 'draft';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gConnId = `${orgId}_google-meet`;
  let gToken: string | null = null;
  for (const providerKey of ['google-meet', 'google']) {
    gToken = await getNangoAccessToken(gConnId, providerKey);
    if (gToken) break;
  }
  if (!gToken) return notConnected('google-meet', actionName, timestamp);

  try {
    if (actionName.includes('get') || actionName.includes('fetch')) {
      const spaceName = payload.space || payload.name;
      if (!spaceName) return apiError('google-meet', 'meet_get_space', timestamp, 'space name is required (spaces/xxx).');
      const getRes = await fetchWithTimeout(`https://meet.googleapis.com/v2/${spaceName}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      const getData = await getRes.json().catch(() => ({}));
      if (!getRes.ok) return apiError('google-meet', 'meet_get_space', timestamp, `Meet get failed: ${getRes.status}`, getData);
      return { tool: 'google-meet', action: 'meet_get_space', status: 'executed' as const, message: `Fetched Meet space ${spaceName}`, data: getData, timestamp };
    }
    const createRes = await fetchWithTimeout('https://meet.googleapis.com/v2/spaces', {
      method: 'POST',
      headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const createData = await createRes.json().catch(() => ({}));
    if (!createRes.ok) return apiError('google-meet', 'meet_create_space', timestamp, `Meet create failed: ${createRes.status}`, createData);
    return { tool: 'google-meet', action: 'meet_create_space', status: 'executed' as const, message: 'Created Google Meet space', data: createData, timestamp };
  } catch (e: any) {
    console.error('[google-meet] API error:', e.message);
    return { tool: 'google-meet', action: actionName, status: 'error' as const, message: `google-meet request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleMeet: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
