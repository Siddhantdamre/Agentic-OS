import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTurnAllowlist, runToolGate, CORE_READ_TOOLS, payloadDenial, type GateDeps, type GateEmployee } from './tool-gate.js';
import { isToolAllowed, resolveCallRisk, pickEmployeeForRole } from './tool-executor.js';
import { roleCapabilityDenial } from './tools/role-capability.js';
import type { OrgRunState } from './tools/gate-hooks.js';

const ORG = '00000000-0000-4000-8000-0000000000aa';

const EMMA: GateEmployee = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Emma',
  role: 'Customer Support',
  rosterKey: null,
  toolAllowlist: ['gmail', 'whatsapp', 'google-calendar', 'customer-ops'],
  status: 'active',
};

interface Fake {
  deps: GateDeps;
  invoked: string[];
  ledger: string[];
  parked: string[];
}

function fakeDeps(overrides: Partial<GateDeps> = {}, opts: { run?: OrgRunState; employee?: GateEmployee | null } = {}): Fake {
  const invoked: string[] = [];
  const ledger: string[] = [];
  const parked: string[] = [];
  const run = opts.run ?? { runnable: true, stage: 3 };
  const employee = opts.employee === undefined ? EMMA : opts.employee;
  const deps: GateDeps = {
    runContext: () => undefined,
    orgRunState: async () => run,
    loadEmployee: async (_org, ref) => (ref.employeeId || ref.employeeRole ? employee : null),
    usageBlock: async () => null,
    entitlement: async () => null,
    payRbac: async () => null,
    loadApprovedAction: async () => null,
    riskFor: resolveCallRisk,
    isAllowed: isToolAllowed,
    personaDenial: (role, tool, action, card) => roleCapabilityDenial(role, tool, action, card),
    skillTierBlock: async () => null,
    checkAutonomy: async () => ({
      mode: 'execute', actionType: 'read', bucket: 'read', reversibility: 'reversible',
      escalationScore: 0, reasonCode: 'within_policy', ruleSource: 'default', tier: 2,
    } as any),
    logAutonomy: async () => {},
    logLedger: async (e) => { ledger.push(`${e.decision}:${e.reasonCode}`); },
    park: async (p) => { parked.push(`${p.tool}.${p.action}`); return { pendingActionId: 'pa-1', workItemId: 'wi-1' }; },
    summarize: (tool, action) => `${tool}.${action}`,
    critic: async () => ({ allow: true, reason: 'ok' }),
    inQuietHours: async () => false,
    invoke: async (params, ctx) => {
      invoked.push(`${params.tool}.${ctx.actionName}`);
      return { tool: params.tool, action: ctx.actionName, status: 'executed', message: 'ok', data: [], timestamp: ctx.timestamp };
    },
    ...overrides,
  };
  return { deps, invoked, ledger, parked };
}

test('omitting employeeId and employeeRole denies with missing_employee', async () => {
  const f = fakeDeps();
  const res = await runToolGate({ tool: 'web_search', action: 'search', payload: { query: 'x' }, orgId: ORG }, f.deps);
  assert.equal(res.status, 'error');
  assert.equal(res.reason, 'missing_employee');
  assert.deepEqual(f.invoked, []);
});

test('empty card is core-read only, not the org union', async () => {
  const bare = { ...EMMA, toolAllowlist: [] };
  const f = fakeDeps({}, { employee: bare });
  const read = await runToolGate({ tool: 'web_search', action: 'search', payload: {}, orgId: ORG, employeeId: bare.id }, f.deps);
  assert.equal(read.status, 'executed');
  const gmail = await runToolGate({ tool: 'gmail', action: 'fetch_latest_emails', payload: {}, orgId: ORG, employeeId: bare.id }, f.deps);
  assert.equal(gmail.reason, 'not_in_allowlist');
  assert.deepEqual(resolveTurnAllowlist([]), CORE_READ_TOOLS);
});

test('a core tool id cannot smuggle a write action (cognee remember)', async () => {
  const f = fakeDeps();
  const res = await runToolGate({ tool: 'cognee', action: 'remember', payload: { text: 'x' }, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.equal(res.reason, 'not_in_allowlist');
  assert.deepEqual(f.invoked, []);
});

test('prefix stripe does not allow stripe_create_charge', async () => {
  const fin = { ...EMMA, name: 'Finance', role: 'Finance', rosterKey: 'finance', toolAllowlist: ['stripe'] };
  // A prefix never matches an unregistered id; a provider key only expands to
  // that provider's registered tools, and a charge still parks.
  const f = fakeDeps({}, { employee: fin });
  const unknown = await runToolGate({ tool: 'stripe_create_charge_extra', action: 'create_charge', payload: { amount: 5 }, orgId: ORG, employeeId: fin.id }, f.deps);
  assert.equal(unknown.reason, 'not_in_allowlist');
  const charge = await runToolGate({ tool: 'stripe_create_charge', action: 'create_charge', payload: { amount: 5 }, orgId: ORG, employeeId: fin.id }, f.deps);
  assert.equal(charge.status, 'pending_approval');
  assert.deepEqual(f.invoked, []);
});

test('a caller allowlist narrows but never widens the card', async () => {
  const f = fakeDeps();
  const widened = await runToolGate({ tool: 'stripe', action: 'create_refund', payload: {}, orgId: ORG, employeeId: EMMA.id, toolAllowlist: ['stripe'] }, f.deps);
  assert.equal(widened.reason, 'not_in_allowlist');
  const narrowed = await runToolGate({ tool: 'gmail', action: 'fetch_latest_emails', payload: {}, orgId: ORG, employeeId: EMMA.id, toolAllowlist: ['whatsapp'] }, f.deps);
  assert.equal(narrowed.reason, 'not_in_allowlist');
});

test('skipAutonomy is ignored: autonomy still runs and can park', async () => {
  let checked = 0;
  const f = fakeDeps({
    checkAutonomy: async () => {
      checked += 1;
      return { mode: 'approval_required', actionType: 'update_record', bucket: 'internal_write', reversibility: 'reversible', escalationScore: 1, reasonCode: 'org_rule_requires_approval', ruleSource: 'default', tier: 2 } as any;
    },
  });
  const res = await runToolGate({ tool: 'gmail', action: 'fetch_latest_emails', payload: {}, orgId: ORG, employeeId: EMMA.id, skipAutonomy: true }, f.deps);
  assert.equal(checked, 1);
  assert.equal(res.status, 'pending_approval');
  assert.deepEqual(f.invoked, []);
});

test('stage 0 lets read-only tools run so a fresh workspace can answer questions', async () => {
  const f = fakeDeps({}, { run: { runnable: true, stage: 0 } });
  const res = await runToolGate({ tool: 'gmail', action: 'fetch_latest_emails', payload: {}, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.notEqual(res.reason, 'shadow');
  assert.ok(!f.ledger.includes('suppressed:shadow_stage'));
});

test('stage 0 is shadow for actions with side effects and never calls the provider', async () => {
  const f = fakeDeps({}, { run: { runnable: true, stage: 0 } });
  const res = await runToolGate({ tool: 'gmail', action: 'send_email', payload: { to: 'a@b.co', body: 'hi' }, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.equal(res.reason, 'shadow');
  assert.deepEqual(f.invoked, []);
  assert.deepEqual(f.ledger, ['suppressed:shadow_stage']);
});

test('kill switch denies chat, plan, and sweep the same way', async () => {
  for (const source of ['chat', 'plan', 'sweep'] as const) {
    const f = fakeDeps({}, { run: { runnable: false, reason: 'kill_switch', stage: 0 } });
    const res = await runToolGate({ tool: 'gmail', action: 'send_email', payload: { to: 'a@b.co', body: 'hi' }, orgId: ORG, employeeRole: 'customer', source }, f.deps);
    assert.equal(res.reason, 'kill_switch', source);
    assert.deepEqual(f.invoked, [], source);
    assert.deepEqual(f.parked, [], source);
  }
});

test('suspended org is org_not_runnable', async () => {
  const f = fakeDeps({}, { run: { runnable: false, reason: 'org_not_runnable', stage: 0 } });
  const res = await runToolGate({ tool: 'web_search', action: 'search', payload: {}, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.equal(res.reason, 'org_not_runnable');
});

test('paused employee is denied', async () => {
  const f = fakeDeps({}, { employee: { ...EMMA, status: 'paused' } });
  const res = await runToolGate({ tool: 'web_search', action: 'search', payload: {}, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.equal(res.reason, 'policy_denied');
});

test('usage cap blocks before any provider call', async () => {
  const f = fakeDeps({ usageBlock: async () => ({ message: 'Hard cap reached' }) });
  const res = await runToolGate({ tool: 'web_search', action: 'search', payload: {}, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.equal(res.reason, 'usage_blocked');
  assert.deepEqual(f.invoked, []);
});

test('pay without an amount is invalid_args; Slack send without a channel is invalid_args', () => {
  assert.match(String(payloadDenial('stripe', 'create_payment_link', 'pay', {})), /amount/);
  assert.equal(payloadDenial('stripe', 'create_payment_link', 'pay', { amount: 1500 }), null);
  assert.equal(payloadDenial('stripe', 'create_refund', 'pay', {}), null);
  assert.match(String(payloadDenial('slack', 'send_channel_message', 'send', { message: 'x' })), /channel/);
});

test('pickEmployeeForRole matches role, then rosterKey, then persona family', () => {
  const rows: GateEmployee[] = [
    { ...EMMA, id: 'a', role: 'Growth', name: 'Growth', rosterKey: null },
    { ...EMMA, id: 'b', role: 'Chief of Staff', name: 'Exec', rosterKey: 'executive' },
    { ...EMMA, id: 'c', role: 'Customer Resolution', name: 'Customer', status: 'paused' },
    { ...EMMA, id: 'd', role: 'Customer Support', name: 'Emma' },
  ];
  assert.equal(pickEmployeeForRole(rows, 'growth')?.id, 'a');
  assert.equal(pickEmployeeForRole(rows, 'executive')?.id, 'b');
  assert.equal(pickEmployeeForRole(rows, 'customer')?.id, 'd');
  assert.equal(pickEmployeeForRole(rows, 'nobody-here'), null);
  assert.equal(pickEmployeeForRole(rows, undefined), null);
});

test('skill tier minimums do not block reads, so a read reaches the provider', async () => {
  const f = fakeDeps({ skillTierBlock: async () => 'Action blocked: autonomy tier 1 is below skill minimum 2 for "gmail".' });
  const res = await runToolGate({ tool: 'gmail', action: 'fetch_latest_emails', payload: {}, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.notEqual(res.reason, 'policy_denied');
  assert.deepEqual(f.invoked, ['gmail.fetch_latest_emails']);
});

test('below the skill tier minimum a send parks for approval instead of being refused', async () => {
  const f = fakeDeps({ skillTierBlock: async () => 'Action blocked: autonomy tier 1 is below skill minimum 2 for "gmail".' });
  const res = await runToolGate({ tool: 'gmail', action: 'send_email', payload: { to: 'a@b.co', subject: 'Hi', body: 'hi' }, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.equal(res.status, 'pending_approval');
  assert.notEqual(res.reason, 'policy_denied');
  assert.deepEqual(f.parked, ['gmail.send_email']);
  assert.deepEqual(f.invoked, []);
});

test('below the skill tier minimum a non-confirm write parks with reason skill_tier', async () => {
  const f = fakeDeps({
    skillTierBlock: async () => 'Action blocked: autonomy tier 1 is below skill minimum 2 for "google-calendar".',
    riskFor: () => ({ risk: 'execute', confirm: false }),
  });
  const res = await runToolGate({ tool: 'google-calendar', action: 'create_event', payload: { summary: 'x' }, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.equal(res.status, 'pending_approval');
  assert.equal((res.data as any)?.reasonCode, 'skill_tier');
  assert.deepEqual(f.invoked, []);
});

test('skill tier minimums do not block drafts', async () => {
  const f = fakeDeps({ skillTierBlock: async () => 'Action blocked: autonomy tier 1 is below skill minimum 2 for "gmail".' });
  const res = await runToolGate({ tool: 'gmail', action: 'draft_email', payload: { to: 'a@b.co', subject: 'Hi', body: 'hi' }, orgId: ORG, employeeId: EMMA.id }, f.deps);
  assert.equal(res.status, 'executed');
  assert.deepEqual(f.invoked, ['gmail.draft_email']);
});

test('an approved send runs even when the employee tier is below the skill minimum', async () => {
  const f = fakeDeps({
    skillTierBlock: async () => 'Action blocked: autonomy tier 1 is below skill minimum 2 for "gmail".',
    loadApprovedAction: async () => ({ id: 'pa-1', tool: 'gmail', action: 'send_email', args: { to: 'a@b.co', subject: 'Hi', body: 'hi' } }),
  });
  const res = await runToolGate({ tool: 'gmail', action: 'send_email', payload: {}, orgId: ORG, employeeId: EMMA.id, approvedPendingActionId: 'pa-1', actorUserId: 'u-1' }, f.deps);
  assert.equal(res.status, 'executed');
  assert.deepEqual(f.invoked, ['gmail.send_email']);
});
