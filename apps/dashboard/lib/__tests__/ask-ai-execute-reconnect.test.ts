/**
 * @jest-environment node
 *
 * Tests for Ask AI plan execution reconnect & resume (ASK-B01).
 * Verifies that reconnecting to a running plan replays already completed steps
 * from database cache without re-invoking tools, runs remaining steps, and
 * prevents duplicate concurrent execution on the same node.
 */

import { GET } from '@/app/api/ask-ai/execute/route';
import { activePlanExecutions } from '@/lib/ask-ai-plan-execution-state';
import { executeAutonomousToolAction } from '@darex/workflows/dist/tool-executor';

const mockOrgId = '00000000-0000-4000-8000-000000000001';
const mockUserId = 'user-test-execute-123';
const mockPlanId = 'plan-0000-0000-0000-000000000001';

// Mock DB
let mockPlanRecord: any = null;
let updatePlanQueries: Array<{ sql: string; params: any[] }> = [];

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({
    orgId: mockOrgId,
    userId: mockUserId,
    client: {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('SELECT * FROM agent_plans')) {
          return { rows: mockPlanRecord ? [mockPlanRecord] : [] };
        }
        if (sql.includes('UPDATE agent_plans')) {
          updatePlanQueries.push({ sql, params });
          return { rowCount: 1 };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    },
  })),
  getOrgScopedClient: jest.fn(async () => ({
    client: {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('SELECT status FROM agent_plans')) {
          return { rows: [{ status: mockPlanRecord?.status || 'running' }] };
        }
        if (sql.includes('UPDATE agent_plans')) {
          updatePlanQueries.push({ sql, params });
          return { rowCount: 1 };
        }
        return { rows: [] };
      }),
    },
  })),
  releaseScopedClient: jest.fn(async () => {}),
  scopedAuthErrorResponse: jest.fn(() => null),
}));

jest.mock('@/lib/usage-gate', () => ({
  assertUsageAllowed: jest.fn(async () => null),
}));

jest.mock('@/lib/rate-limit', () => ({
  denyAskAiBusy: jest.fn(() => new Response('Busy', { status: 429 })),
  denyAskAiIfLimited: jest.fn(() => null),
  isRateLimitError: jest.fn(() => false),
  responseFromRateLimit: jest.fn(() => new Response('Rate limit', { status: 429 })),
  tryAcquireConcurrency: jest.fn(() => ({ release: jest.fn() })),
}));

jest.mock('@darex/workflows/dist/tool-executor', () => ({
  executeAutonomousToolAction: jest.fn(async (opts: any) => ({
    status: 'executed',
    message: `Executed ${opts.tool}`,
    data: { output: 'success' },
  })),
}));

jest.mock('@darex/workflows/dist/plan-step-actor', () => ({
  resolvePlanStepActor: jest.fn(async () => ({
    ok: true,
    employeeId: 'emp-123',
    employeeRole: 'Executive',
    toolAllowlist: ['mock_tool_1', 'mock_tool_2'],
  })),
}));

jest.mock('@darex/workflows/dist/plan-steps', () => ({
  planRequiresDurableExecute: jest.fn(() => false),
  stageSteps: jest.fn((steps: any[]) => steps.map((s, i) => [{ s, i }])),
  wireDependencies: jest.fn((step: any) => step.payload || {}),
}));

jest.mock('@darex/workflows/dist/workflow-client', () => ({
  getPlanExecuteHandle: jest.fn(async () => null),
  signalPlanDecision: jest.fn(async () => {}),
  startPlanExecuteWorkflow: jest.fn(async () => null),
}));

jest.mock('@/lib/audit-events', () => ({
  recordAuditEvent: jest.fn(async () => {}),
}));

jest.mock('@/lib/langfuse-trace', () => ({
  logLangfuseTrace: jest.fn(async () => {}),
}));

describe('Ask AI Plan Execute Reconnect (ASK-B01)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updatePlanQueries = [];
    activePlanExecutions.clear();
  });

  it('rejects with 409 if plan is already completed', async () => {
    mockPlanRecord = {
      id: mockPlanId,
      org_id: mockOrgId,
      user_id: mockUserId,
      status: 'completed',
      current_step: 2,
      steps: [
        { tool: 'mock_tool_1', action: 'act', enabled: true },
        { tool: 'mock_tool_2', action: 'act', enabled: true },
      ],
    };

    const req = new Request(`http://localhost:3000/api/ask-ai/execute?planId=${mockPlanId}`);
    const res = await GET(req);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain('Plan already completed');
  });

  it('rejects with 409 if another execution is actively running in-flight on the same node', async () => {
    mockPlanRecord = {
      id: mockPlanId,
      org_id: mockOrgId,
      user_id: mockUserId,
      status: 'running',
      current_step: 0,
      steps: [{ tool: 'mock_tool_1', action: 'act', enabled: true }],
    };

    // Mark plan as actively in-flight
    activePlanExecutions.add(mockPlanId);

    const req = new Request(`http://localhost:3000/api/ask-ai/execute?planId=${mockPlanId}`);
    const res = await GET(req);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain('Plan is already executing in an active stream');
  });

  it('resumes a running plan, replaying completed steps without calling tool-executor for them', async () => {
    // Step 0 was already completed in prior run, step 1 is pending
    mockPlanRecord = {
      id: mockPlanId,
      org_id: mockOrgId,
      user_id: mockUserId,
      status: 'running',
      current_step: 1,
      steps: [
        {
          id: 's0',
          tool: 'mock_tool_1',
          action: 'read',
          description: 'Step 1 description',
          enabled: true,
          status: 'completed',
          result: { cached: true },
          message: 'Cached step result',
        },
        {
          id: 's1',
          tool: 'mock_tool_2',
          action: 'write',
          description: 'Step 2 description',
          enabled: true,
        },
      ],
    };

    const req = new Request(`http://localhost:3000/api/ask-ai/execute?planId=${mockPlanId}`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let streamText = '';
    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      streamText += decoder.decode(value);
    }

    // executeAutonomousToolAction must only have been called ONCE (for step 1), NOT for step 0
    expect(executeAutonomousToolAction).toHaveBeenCalledTimes(1);
    expect(executeAutonomousToolAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'mock_tool_2',
        action: 'write',
      })
    );

    // Verify stream contained replayed step 0 events and new step 1 events
    expect(streamText).toContain('event: execution_start');
    expect(streamText).toContain('event: step_start');
    expect(streamText).toContain('event: step_done');
    expect(streamText).toContain('event: execution_done');
    expect(streamText).toContain('Cached step result');

    // Verify final plan status was marked completed
    const finalUpdate = updatePlanQueries.find((q) => q.sql.includes('status ='));
    expect(finalUpdate).toBeDefined();
  });
});
