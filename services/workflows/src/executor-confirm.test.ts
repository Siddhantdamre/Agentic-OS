import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolGate, type GateDeps, type GateEmployee } from './tool-gate.js';
import { isToolAllowed, resolveCallRisk } from './tool-executor.js';
import { roleCapabilityDenial } from './tools/role-capability.js';
import { isToolApprovalRequired } from './local-turn.js';

const ORG = '00000000-0000-4000-8000-0000000000bb';
const CUSTOMER: GateEmployee = {
  id: '00000000-0000-4000-8000-000000000010',
  name: 'Customer',
  role: 'Customer Resolution',
  rosterKey: 'customer',
  toolAllowlist: ['gmail', 'whatsapp', 'stripe', 'hubspot', 'customer-ops'],
  status: 'active',
};

function deps(overrides: Partial<GateDeps> = {}) {
  const invoked: Array<{ tool: string; payload: Record<string, unknown> }> = [];
  const d: GateDeps = {
    runContext: () => undefined,
    orgRunState: async () => ({ runnable: true, stage: 3 }),
    loadEmployee: async () => CUSTOMER,
    usageBlock: async () => null,
    entitlement: async () => null,
    payRbac: async () => null,
    loadApprovedAction: async () => null,
    riskFor: resolveCallRisk,
    isAllowed: isToolAllowed,
    personaDenial: (role, tool, action, card) => roleCapabilityDenial(role, tool, action, card),
    skillTierBlock: async () => null,
    checkAutonomy: async () => ({ mode: 'execute', actionType: 'x', bucket: 'x', reversibility: 'reversible', escalationScore: 0, reasonCode: 'within_policy', ruleSource: 'default', tier: 3 } as any),
    logAutonomy: async () => {},
    logLedger: async () => {},
    park: async () => ({ pendingActionId: 'pa-9', workItemId: 'wi-9' }),
    summarize: (tool, action) => `${tool}.${action}`,
    critic: async () => ({ allow: true, reason: 'ok' }),
    inQuietHours: async () => false,
    invoke: async (params, ctx) => {
      invoked.push({ tool: params.tool, payload: params.payload });
      return { tool: params.tool, action: ctx.actionName, status: 'executed', message: 'ok', data: null, timestamp: ctx.timestamp };
    },
    ...overrides,
  };
  return { d, invoked };
}

const SEND = { tool: 'gmail', action: 'send_email', payload: { to: 'jane@acme.com', subject: 'Hi', body: 'On it' } };
const CHARGE = { tool: 'stripe', action: 'create_charge', payload: { amount: 2000, customer: 'cus_1' } };

for (const source of ['plan', 'sweep', 'chat'] as const) {
  test(`gmail.send_email and stripe.create_charge park from ${source}, with no token`, async () => {
    for (const call of [SEND, CHARGE]) {
      const { d, invoked } = deps();
      const res = await runToolGate({ ...call, orgId: ORG, employeeRole: 'customer', source }, d);
      assert.equal(res.status, 'pending_approval', `${source} ${call.tool}`);
      assert.equal(invoked.length, 0);
      assert.equal(JSON.stringify(res).includes('token'), false);
      assert.equal(res.approval?.pendingActionId, 'pa-9');
    }
  });
}

test('approval path runs the STORED payload, not the caller copy', async () => {
  const { d, invoked } = deps({
    loadApprovedAction: async () => ({ id: 'pa-9', tool: 'stripe', action: 'create_charge', args: { amount: 2000, customer: 'cus_1' } }),
  });
  const res = await runToolGate({ ...CHARGE, payload: { amount: 999999, customer: 'cus_1' }, orgId: ORG, employeeId: CUSTOMER.id, approvedPendingActionId: 'pa-9', actorUserId: 'u1', source: 'approval' }, d);
  assert.equal(res.status, 'executed');
  assert.equal(invoked[0].payload.amount, 2000);
});

test('approval that does not match the stored tool is refused', async () => {
  const { d, invoked } = deps({
    loadApprovedAction: async () => ({ id: 'pa-9', tool: 'gmail', action: 'draft_email', args: {} }),
  });
  const res = await runToolGate({ ...SEND, orgId: ORG, employeeId: CUSTOMER.id, approvedPendingActionId: 'pa-9' }, d);
  assert.equal(res.reason, 'policy_denied');
  assert.equal(invoked.length, 0);
});

test('approved pay action still needs a pay-capable approver', async () => {
  const { d, invoked } = deps({
    loadApprovedAction: async () => ({ id: 'pa-9', tool: 'stripe', action: 'create_charge', args: { amount: 2000 } }),
    payRbac: async () => ({ reason: 'policy_denied', message: 'member cannot approve pay actions' }),
  });
  const res = await runToolGate({ ...CHARGE, orgId: ORG, employeeId: CUSTOMER.id, approvedPendingActionId: 'pa-9', actorUserId: 'member-1' }, d);
  assert.equal(res.reason, 'policy_denied');
  assert.equal(invoked.length, 0);
});

test('kill switch stops an already-approved send', async () => {
  const { d, invoked } = deps({
    orgRunState: async () => ({ runnable: false, reason: 'kill_switch', stage: 0 }),
    loadApprovedAction: async () => ({ id: 'pa-9', tool: 'gmail', action: 'send_email', args: SEND.payload }),
  });
  const res = await runToolGate({ ...SEND, orgId: ORG, employeeId: CUSTOMER.id, approvedPendingActionId: 'pa-9' }, d);
  assert.equal(res.reason, 'kill_switch');
  assert.equal(invoked.length, 0);
});

test('critic blocks a violating draft before it is parked or sent', async () => {
  let parked = 0;
  const { d, invoked } = deps({
    critic: async () => ({ allow: false, reason: 'fair housing: steering' }),
    park: async () => { parked += 1; return { pendingActionId: 'x', workItemId: null }; },
  });
  const res = await runToolGate({ ...SEND, orgId: ORG, employeeId: CUSTOMER.id }, d);
  assert.equal(res.reason, 'critic');
  assert.equal(parked, 0);
  assert.equal(invoked.length, 0);
});

test('sweep-resumed approved send waits out quiet hours; a human approval does not', async () => {
  const approvedSend = async () => ({ id: 'pa-9', tool: 'gmail', action: 'send_email', args: SEND.payload });
  const sweep = deps({ loadApprovedAction: approvedSend, inQuietHours: async () => true });
  const deferred = await runToolGate({ ...SEND, orgId: ORG, employeeId: CUSTOMER.id, approvedPendingActionId: 'pa-9', source: 'sweep' }, sweep.d);
  assert.equal(deferred.reason, 'quiet_hours');
  const human = deps({ loadApprovedAction: approvedSend, inQuietHours: async () => true });
  const sent = await runToolGate({ ...SEND, orgId: ORG, employeeId: CUSTOMER.id, approvedPendingActionId: 'pa-9', actorUserId: 'owner-1' }, human.d);
  assert.equal(sent.status, 'executed');
});

test('isToolApprovalRequired requires approval for confirm-class tools regardless of REQUIRE_TOOL_APPROVAL (ASK-S05)', () => {
  // Confirm classes: pay, send, execute, delete
  assert.equal(isToolApprovalRequired({ toolName: 'stripe_create_charge', riskMeta: { risk: 'pay', confirm: true }, env: {} }), true);
  assert.equal(isToolApprovalRequired({ toolName: 'gmail_send_email', riskMeta: { risk: 'send', confirm: true }, env: {} }), true);
  assert.equal(isToolApprovalRequired({ toolName: 'python_execute', riskMeta: { risk: 'execute', confirm: true }, env: {} }), true);
  assert.equal(isToolApprovalRequired({ toolName: 'file_ops_delete', riskMeta: { risk: 'delete', confirm: true }, env: {} }), true);
});

test('isToolApprovalRequired leaves read tools unconfirmed', () => {
  assert.equal(isToolApprovalRequired({ toolName: 'web_search', riskMeta: { risk: 'read', confirm: false }, env: {} }), false);
  assert.equal(isToolApprovalRequired({ toolName: 'gmail_fetch', riskMeta: { risk: 'read', confirm: false }, env: {} }), false);
  assert.equal(isToolApprovalRequired({ toolName: 'drive_list', riskMeta: { risk: 'read', confirm: false }, env: {} }), false);
});

test('isToolApprovalRequired defaults to requiring approval for general write tools, but allows disabling via REQUIRE_TOOL_APPROVAL=false', () => {
  // Write tool with draft risk
  assert.equal(isToolApprovalRequired({ toolName: 'gmail_draft_email', riskMeta: { risk: 'draft', confirm: false }, env: {} }), true);
  assert.equal(isToolApprovalRequired({ toolName: 'gmail_draft_email', riskMeta: { risk: 'draft', confirm: false }, env: { REQUIRE_TOOL_APPROVAL: 'false' } }), false);
  // Confirm class still requires approval even if REQUIRE_TOOL_APPROVAL=false
  assert.equal(isToolApprovalRequired({ toolName: 'stripe_create_charge', riskMeta: { risk: 'pay', confirm: true }, env: { REQUIRE_TOOL_APPROVAL: 'false' } }), true);
});

test('resolveToolRisk checks mod.confirm and confirmForRisk unconditionally (RT-B07)', () => {
  const stripeRisk = resolveCallRisk('stripe', 'create_charge');
  assert.equal(stripeRisk?.risk, 'pay');
  assert.equal(stripeRisk?.confirm, true);

  const gmailRisk = resolveCallRisk('gmail', 'send_email');
  assert.equal(gmailRisk?.risk, 'send');
  assert.equal(gmailRisk?.confirm, true);

  const searchRisk = resolveCallRisk('web_search', 'search');
  assert.equal(searchRisk?.risk, 'read');
  assert.equal(searchRisk?.confirm, false);
});
