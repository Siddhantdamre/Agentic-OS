import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, nangoAuthError, notConnected, resolveGoogleAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = ['forms_get', 'forms_get_responses'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const _gAuth = await resolveGoogleAuth(orgId, 'google-forms');
  const gToken: string | null = _gAuth.kind === 'connected' ? _gAuth.accessToken : null;
  const _gAuthErr = _gAuth.kind === 'connected' ? null : nangoAuthError('google-forms', actionName, timestamp, _gAuth);
  if (!gToken) return _gAuthErr ?? notConnected('google-forms', actionName, timestamp);

  try {
    const formId = payload.formId || payload.id;
    if (!formId) {
      return { tool: 'google-forms', action: actionName, status: 'error' as const, message: 'formId is required.', data: null, timestamp };
    }

    if (actionName.includes('response')) {
      const respRes = await fetchWithTimeout(`https://forms.googleapis.com/v1/forms/${formId}/responses`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      if (!respRes.ok) {
        return { tool: 'google-forms', action: 'forms_get_responses', status: 'error' as const, message: `Forms responses error ${respRes.status}: ${await respRes.text()}`, data: null, timestamp };
      }
      const respData = await respRes.json();
      return {
        tool: 'google-forms',
        action: 'forms_get_responses',
        status: 'executed' as const,
        message: `Fetched ${(respData.responses || []).length} responses for form ${formId}`,
        data: { formId, responses: respData.responses || [] },
        timestamp,
      };
    }

    const formsRes = await fetchWithTimeout(`https://forms.googleapis.com/v1/forms/${formId}`, {
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
