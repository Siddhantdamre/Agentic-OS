import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['slides_create'] as const;

function riskFor(_action: string): ToolRisk {
  return 'draft';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gConnId = `${orgId}_google-slides`;
  let gToken: string | null = null;
  for (const providerKey of ['google-slides', 'google']) {
    gToken = await getNangoAccessToken(gConnId, providerKey);
    if (gToken) break;
  }
  if (!gToken) return notConnected('google-slides', actionName, timestamp);

  try {
    const title = payload.title || 'Untitled Presentation';
    const slidesRes = await fetch('https://slides.googleapis.com/v1/presentations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!slidesRes.ok) {
      return { tool: 'google-slides', action: 'slides_create', status: 'error' as const, message: `Slides error ${slidesRes.status}: ${await slidesRes.text()}`, data: null, timestamp };
    }
    const slidesData = await slidesRes.json();
    return {
      tool: 'google-slides',
      action: 'slides_create',
      status: 'executed' as const,
      message: `Created presentation "${slidesData.title}"`,
      data: { presentationId: slidesData.presentationId, title: slidesData.title },
      timestamp,
    };
  } catch (e: any) {
    console.error('[google-slides] API error:', e.message);
    return { tool: 'google-slides', action: actionName, status: 'error' as const, message: `google-slides request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleSlides: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
