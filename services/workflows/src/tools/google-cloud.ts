import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['cloud_list_projects'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, orgId, timestamp } = ctx;
  const gConnId = `${orgId}_google-cloud`;
  let gToken: string | null = null;
  for (const providerKey of ['google-cloud', 'google']) {
    gToken = await getNangoAccessToken(gConnId, providerKey);
    if (gToken) break;
  }
  if (!gToken) return notConnected('google-cloud', actionName, timestamp);

  try {
    const projRes = await fetchWithTimeout('https://cloudresourcemanager.googleapis.com/v1/projects', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    const projData = await projRes.json().catch(() => ({}));
    if (!projRes.ok) return apiError('google-cloud', 'cloud_list_projects', timestamp, `Cloud Resource Manager failed: ${projRes.status}`, projData);
    return {
      tool: 'google-cloud',
      action: 'cloud_list_projects',
      status: 'executed' as const,
      message: `Listed ${projData.projects?.length || 0} GCP projects`,
      data: { projects: projData.projects || [] },
      timestamp,
    };
  } catch (e: any) {
    console.error('[google-cloud] API error:', e.message);
    return { tool: 'google-cloud', action: actionName, status: 'error' as const, message: `google-cloud request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleCloud: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
