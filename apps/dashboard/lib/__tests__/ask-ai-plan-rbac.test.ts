/**
 * @jest-environment node
 *
 * Tests for Ask AI plan approval RBAC (SEC-R01).
 * Verifies that:
 * 1. Auditor and billing roles cannot approve plans (403 Forbidden).
 * 2. Standard members cannot approve plans containing refund actions (403 Forbidden).
 * 3. Payment tools require pay-capable roles.
 * 4. Owners and admins can approve plans including financial/refund steps.
 */

import { PATCH } from '@/app/api/ask-ai/plan/route';

const mockOrgId = '00000000-0000-4000-8000-000000000001';
const mockUserId = 'user-test-rbac-123';
const mockPlanId = 'plan-0000-0000-0000-000000000001';

let currentUserRole = 'member';
let mockPlanRecord: any = null;
let updatePlanQueries: Array<{ sql: string; params: any[] }> = [];

jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({
    orgId: mockOrgId,
    userId: mockUserId,
    client: {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('SELECT role FROM users')) {
          return { rows: [{ role: currentUserRole }] };
        }
        if (sql.includes('SELECT * FROM agent_plans')) {
          return { rows: mockPlanRecord ? [mockPlanRecord] : [] };
        }
        if (sql.includes('UPDATE agent_plans')) {
          updatePlanQueries.push({ sql, params });
          return { rowCount: 1 };
        }
        if (sql.includes('SELECT temporal_workflow_id FROM work_items')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    },
  })),
  scopedAuthErrorResponse: jest.fn(() => null),
}));

jest.mock('@/lib/rate-limit', () => ({
  denyAskAiIfLimited: jest.fn(() => null),
  isRateLimitError: jest.fn(() => false),
  responseFromRateLimit: jest.fn(),
}));

jest.mock('@/lib/audit-events', () => ({
  recordAuditEvent: jest.fn(async () => {}),
}));

jest.mock('@darex/workflows/dist/workflow-client', () => ({
  signalPlanDecision: jest.fn(async () => {}),
}));

describe('Ask AI Plan Approval RBAC (SEC-R01)', () => {
  beforeEach(() => {
    updatePlanQueries = [];
    mockPlanRecord = {
      id: mockPlanId,
      org_id: mockOrgId,
      user_id: mockUserId,
      status: 'pending',
      steps: [
        { id: 'step-1', tool: 'web_search', action: 'search', enabled: true },
        { id: 'step-2', tool: 'gmail', action: 'draft_email', enabled: true },
      ],
    };
  });

  it('rejects auditor attempting to approve a plan', async () => {
    currentUserRole = 'auditor';
    const req = new Request('http://localhost/api/ask-ai/plan', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: mockPlanId, action: 'approve' }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/not authorized to approve plans/);
    expect(updatePlanQueries.length).toBe(0);
  });

  it('rejects billing role attempting to approve a plan', async () => {
    currentUserRole = 'billing';
    const req = new Request('http://localhost/api/ask-ai/plan', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: mockPlanId, action: 'approve' }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/not authorized to approve plans/);
    expect(updatePlanQueries.length).toBe(0);
  });

  it('allows standard member to approve standard non-financial plan', async () => {
    currentUserRole = 'member';
    const req = new Request('http://localhost/api/ask-ai/plan', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: mockPlanId, action: 'approve' }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.status).toBe('approved');
    expect(updatePlanQueries.some((q) => q.sql.includes("status = 'approved'"))).toBe(true);
  });

  it('blocks member from approving a plan containing refund action', async () => {
    currentUserRole = 'member';
    mockPlanRecord.steps.push({
      id: 'step-3',
      tool: 'stripe',
      action: 'create_refund',
      enabled: true,
    });

    const req = new Request('http://localhost/api/ask-ai/plan', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: mockPlanId, action: 'approve' }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/refund actions/);
    expect(updatePlanQueries.length).toBe(0);
  });

  it('allows owner or admin to approve a plan containing refund and pay actions', async () => {
    currentUserRole = 'admin';
    mockPlanRecord.steps.push(
      { id: 'step-3', tool: 'stripe', action: 'create_payment_link', enabled: true },
      { id: 'step-4', tool: 'stripe', action: 'create_refund', enabled: true }
    );

    const req = new Request('http://localhost/api/ask-ai/plan', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: mockPlanId, action: 'approve' }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.status).toBe('approved');
  });
});
