/**
 * @jest-environment node
 *
 * Review Action starts a background workflow. When the workflow engine is not reachable the route answered
 * "Temporal is unavailable — InsightActionWorkflow was not started", and the Insight page printed that under
 * every card. That names internal systems the customer has never heard of. The answer is now one plain sentence.
 */
jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() }, orgId: 'org-1', userId: 'u-1' })),
  scopedAuthErrorResponse: () => null,
}));
jest.mock('@/lib/insight-engine', () => ({
  buildInsightCards: jest.fn(),
  queryRegisteredMetrics: jest.fn(),
  isInsightNamedWorkflow: () => true,
  recommendedWorkflowForMetric: () => 'named_workflow',
}));
jest.mock('@/lib/org-cost', () => ({ fetchOrgWeeklyCost: jest.fn(), LangfuseUnavailableError: class extends Error {}, queryConfirmRejectDrift: jest.fn() }));
jest.mock('@darex/workflows/dist/workflow-client', () => ({ startInsightActionWorkflow: jest.fn(async () => null) }));

import { POST } from '../route';

describe('POST /api/insight when the workflow engine is unavailable', () => {
  it('answers 503 with a plain sentence that names no internal system', async () => {
    const req = new Request('http://x/api/insight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metricId: 'plans_waiting' }) });
    const res = await POST(req as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).not.toMatch(/temporal|workflow|InsightAction/i);
    expect(body.error).toMatch(/try again/i);
  });
});
