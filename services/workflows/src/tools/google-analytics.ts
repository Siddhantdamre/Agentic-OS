import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['analytics_report'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gConnId = `${orgId}_google-analytics`;
  let gToken: string | null = null;
  for (const providerKey of ['google-analytics', 'google']) {
    gToken = await getNangoAccessToken(gConnId, providerKey);
    if (gToken) break;
  }
  if (!gToken) return notConnected('google-analytics', actionName, timestamp);

  try {
    const propertyId = String(payload.propertyId || payload.property || '').replace(/^properties\//, '');
    if (!propertyId) {
      return apiError('google-analytics', 'analytics_report', timestamp, 'propertyId is required (GA4 numeric property id).');
    }
    const metrics = Array.isArray(payload.metrics) && payload.metrics.length
      ? payload.metrics
      : [{ name: 'activeUsers' }, { name: 'sessions' }];
    const dimensions = Array.isArray(payload.dimensions) ? payload.dimensions : [{ name: 'date' }];
    const dateRanges = payload.dateRanges || [{ startDate: '7daysAgo', endDate: 'today' }];
    const reportRes = await fetchWithTimeout(
      `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ metrics, dimensions, dateRanges, limit: payload.limit || 25 }),
      },
    );
    const reportData = await reportRes.json().catch(() => ({}));
    if (!reportRes.ok) {
      return apiError('google-analytics', 'analytics_report', timestamp, `Analytics report failed: ${reportRes.status}`, reportData);
    }
    return {
      tool: 'google-analytics',
      action: 'analytics_report',
      status: 'executed' as const,
      message: `Ran GA4 report for property ${propertyId}`,
      data: { propertyId, rowCount: reportData.rowCount || 0, rows: reportData.rows || [], metricHeaders: reportData.metricHeaders, dimensionHeaders: reportData.dimensionHeaders },
      timestamp,
    };
  } catch (e: any) {
    console.error('[google-analytics] API error:', e.message);
    return { tool: 'google-analytics', action: actionName, status: 'error' as const, message: `google-analytics request failed: ${e.message}`, data: null, timestamp };
  }
}

export const googleAnalytics: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
