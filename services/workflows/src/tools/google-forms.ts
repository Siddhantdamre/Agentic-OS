import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['forms_get'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gConnId = `${orgId}_google-forms`;
  let gToken: string | null = null;
  for (const providerKey of ['google-forms', 'google']) {
    gToken = await getNangoAccessToken(gConnId, providerKey);
    if (gToken) break;
  }
  if (!gToken) return notConnected('google-forms', actionName, timestamp);

  try {
    const formId = payload.formId || payload.id;
    if (!formId) {
      return { tool: 'google-forms', action: 'forms_get', status: 'error' as const, message: 'formId is required.', data: null, timestamp };
    }
    const formsRes = await fetch(`https://forms.googleapis.com/v1/forms/${formId}`, {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    if (!formsRes.ok) {
      return { tool: 'google-forms', action: 'forms_get', status: 'error' as const, message: `Forms error ${formsRes.status}: ${await formsRes.text()}`, data: null, timestamp };
    }
    const formData = await formsRes.json();
    return {
      tool: 'google-forms',
      action: 'forms_get',
      status: 'executed' as const,
      message: `Fetched form "${formData.info?.title || formId}"`,
      data: { formId, title: formData.info?.title, items: formData.items || [] },
      timestamp,
    };
  } catch (e: any) {
    console.error('[google-forms] API error:', e.message);
    return { tool: 'google-forms', action: actionName, status: 'error' as const, message: `google-forms request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleForms: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
