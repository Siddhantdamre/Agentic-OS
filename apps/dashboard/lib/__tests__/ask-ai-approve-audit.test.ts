/**
 * @jest-environment node
 *
 * ASK-E01: an in-chat tool approval or denial is audited before the paused
 * turn resumes, and nothing resumes when the audit row cannot be written.
 */
const recordAuditEvent = jest.fn();
const resumeTrueForgeTurn = jest.fn();
jest.mock('@/lib/audit-events', () => ({ recordAuditEvent: (...a: unknown[]) => recordAuditEvent(...a) }));
jest.mock('@/lib/db', () => ({
  getScopedClient: jest.fn(async () => ({ client: { query: jest.fn(), release: jest.fn() }, orgId: 'org-1', userId: 'u-1' })),
  scopedAuthErrorResponse: jest.fn(() => null),
}));
jest.mock('@/lib/rbac', () => ({
  loadHumanRole: jest.fn(async () => 'admin'),
  canApproveActions: () => true,
  canApproveRefunds: () => true,
  canCallPayTools: () => true,
  isPayTool: () => false,
}));
jest.mock('@/lib/langfuse-trace', () => ({ logLangfuseTrace: jest.fn(async () => {}) }));
jest.mock('@/lib/ask-ai-persist', () => ({ persistAskAiMessage: jest.fn() }));
jest.mock('@/lib/plan-generator', () => ({ VALID_TOOLS: ['gmail'] }));
jest.mock('@darex/workflows/dist/trueforge-client', () => ({ resumeTrueForgeTurn: (...a: unknown[]) => resumeTrueForgeTurn(...a) }));
jest.mock('@darex/workflows/dist/agent-client', () => ({
  mapTurnToResult: () => ({ replyMessage: 'done', usedTools: [], executedSteps: [] }),
  sanitizeAgentReply: (s: string) => s,
}));
jest.mock('@darex/workflows/dist/workflow-client', () => ({ startMemoryWriteBackWorkflow: jest.fn() }));

import { POST } from '@/app/api/ask-ai/approve/route';

const SESSION = '22222222-2222-4222-8222-222222222222';
const req = () =>
  new Request('http://x/api/ask-ai/approve', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: SESSION,
      decisions: [
        { threadId: 't1', toolCallId: 'c1', tool: 'gmail', action: 'send_email', decision: 'allow' },
        { threadId: 't1', toolCallId: 'c2', tool: 'slack', action: 'post', decision: 'deny', reason: 'wrong channel' },
      ],
    }),
  });

beforeEach(() => {
  recordAuditEvent.mockReset().mockResolvedValue(undefined);
  resumeTrueForgeTurn.mockReset().mockResolvedValue({});
});

it('audits each decision with its tool before resuming', async () => {
  const res = await POST(req());
  expect(res.status).toBe(200);
  await res.text();
  expect(recordAuditEvent.mock.calls.map(([e]) => [e.kind, e.tool, e.action, e.payload.toolCallId])).toEqual([
    ['tool.approve', 'gmail', 'send_email', 'c1'],
    ['tool.deny', 'slack', 'post', 'c2'],
  ]);
  expect(recordAuditEvent.mock.calls[0][0].actor).toEqual({ actorType: 'user', userId: 'u-1' });
  expect(resumeTrueForgeTurn).toHaveBeenCalledTimes(1);
});

it('does not resume the turn when the approval cannot be audited', async () => {
  recordAuditEvent.mockRejectedValueOnce(new Error('violates check constraint "audit_events_kind_chk"'));
  const res = await POST(req());
  expect(res.status).toBe(500);
  expect(resumeTrueForgeTurn).not.toHaveBeenCalled();
});
