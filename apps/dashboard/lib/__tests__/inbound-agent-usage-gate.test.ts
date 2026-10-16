/**
 * @jest-environment node
 *
 * Webhook-started agent turns must be cap-checked up front: over the hard cap
 * no model/workflow starts, nothing is sent, and the block is recorded.
 */
import { fireInboundAgent, type InboundAgentJob } from '@/lib/inbound-agent';

const query = jest.fn();
const release = jest.fn();
jest.mock('@/lib/db', () => ({
  getOrgScopedClient: jest.fn(async () => ({ client: { query: (...a: unknown[]) => query(...a), release: () => release() } })),
}));
jest.mock('@/lib/realtime-hub', () => ({ realtimeHub: { publish: jest.fn() } }));
jest.mock('@/lib/channel-outbound', () => ({ sendChannelReply: jest.fn() }));
jest.mock('@/lib/inbound-confirm', () => ({ evaluateInboundConfirm: jest.fn() }));
jest.mock('@/lib/failed-webhooks', () => ({ recordOutboundDelivery: jest.fn() }));

const mockAssert = jest.fn();
jest.mock('@/lib/usage-gate', () => ({ assertUsageAllowed: (...a: unknown[]) => mockAssert(...a) }));

const startWorkItemWorkflow = jest.fn();
const runAutonomousAgentDirect = jest.fn();
jest.mock('@darex/workflows/dist/workflow-client', () => ({
  startWorkItemWorkflow: (...a: unknown[]) => startWorkItemWorkflow(...a),
  signalNurtureCancelled: jest.fn(async () => undefined),
}));
jest.mock('@darex/workflows/dist/agent-client', () => ({
  runAutonomousAgentDirect: (...a: unknown[]) => runAutonomousAgentDirect(...a),
}));
jest.mock('@darex/workflows/dist/inbound-hitl', () => ({ runInboundDirectFallback: jest.fn() }));

const job: InboundAgentJob = {
  orgId: '00000000-0000-4000-8000-000000000001',
  conversationId: '00000000-0000-4000-8000-0000000000c1',
  employeeName: 'E',
  employeeRole: 'r',
  employeePersona: 'p',
  toolAllowlist: [],
  connectedChannels: [],
  userMessage: 'hi',
  inboundEventId: 'wamid.1',
  replyTarget: { channelType: 'whatsapp' } as InboundAgentJob['replyTarget'],
};

const flush = () => new Promise((r) => setTimeout(r, 30));

describe('inbound agent usage gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue({ rows: [{ id: 'wi1' }] });
  });

  it('over cap: no workflow or model call, records usage_cap_blocked event', async () => {
    mockAssert.mockResolvedValue({ error: 'USAGE_CAP_REACHED', message: 'm', gate: { reasons: [{ kind: 'llm_tokens' }] } });
    fireInboundAgent(job);
    await flush();
    expect(startWorkItemWorkflow).not.toHaveBeenCalled();
    expect(runAutonomousAgentDirect).not.toHaveBeenCalled();
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes("'usage_cap_blocked'"))).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  it('gate error fails closed', async () => {
    mockAssert.mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fireInboundAgent(job);
    await flush();
    expect(startWorkItemWorkflow).not.toHaveBeenCalled();
    expect(runAutonomousAgentDirect).not.toHaveBeenCalled();
  });

  it('under cap: proceeds to start the workflow', async () => {
    mockAssert.mockResolvedValue(null);
    startWorkItemWorkflow.mockResolvedValue(null);
    runAutonomousAgentDirect.mockResolvedValue({});
    fireInboundAgent(job);
    await flush();
    expect(startWorkItemWorkflow).toHaveBeenCalled();
  });
});
