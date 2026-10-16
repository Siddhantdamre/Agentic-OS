/**
 * The Trust page tells a customer what their team may do alone at each level. That sentence must
 * be what the gate really does, so this test runs the real gate (runToolGate) for every level and
 * every risk class and compares the outcome with the table the page is built from
 * (apps/dashboard/lib/trust-levels.json). Change the gate and this fails until the page is told.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runToolGate, type GateDeps, type GateEmployee } from './tool-gate.js';
import { confirmForRisk, type ToolRisk } from './tools/risk.js';

const TABLE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../apps/dashboard/lib/trust-levels.json'), 'utf8'),
) as { risks: ToolRisk[]; stages: Record<string, Record<string, 'runs' | 'asks' | 'recorded'>> };

const ORG = '00000000-0000-4000-8000-0000000000aa';
const EMMA: GateEmployee = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Emma',
  role: 'Customer Support',
  rosterKey: null,
  toolAllowlist: ['gmail'],
  status: 'active',
};

/** Runs one call of the given risk class through the real gate at the given level; reports what happened. */
async function outcome(stage: 0 | 1 | 2 | 3, risk: ToolRisk): Promise<'runs' | 'asks' | 'recorded'> {
  let invoked = false;
  let parked = false;
  const deps: GateDeps = {
    runContext: () => undefined,
    orgRunState: async () => ({ runnable: true, stage }),
    loadEmployee: async () => EMMA,
    usageBlock: async () => null,
    entitlement: async () => null,
    payRbac: async () => null,
    loadApprovedAction: async () => null,
    riskFor: () => ({ risk, confirm: confirmForRisk(risk) }),
    isAllowed: () => true,
    personaDenial: () => null,
    skillTierBlock: async () => null,
    checkAutonomy: async () => ({
      mode: 'execute', actionType: 'read', bucket: 'read', reversibility: 'reversible',
      escalationScore: 0, reasonCode: 'within_policy', ruleSource: 'default', tier: 2,
    } as never),
    logAutonomy: async () => {},
    logLedger: async () => {},
    park: async () => { parked = true; return { pendingActionId: 'pa-1', workItemId: 'wi-1' }; },
    summarize: (tool, action) => `${tool}.${action}`,
    critic: async () => ({ allow: true, reason: 'ok' }),
    inQuietHours: async () => false,
    invoke: async (params, ctx) => {
      invoked = true;
      return { tool: params.tool, action: ctx.actionName, status: 'executed', message: 'ok', data: [], timestamp: ctx.timestamp };
    },
  };
  const res = await runToolGate({ tool: 'gmail', action: 'anything', payload: { to: 'a@b.co', body: 'hi' }, orgId: ORG, employeeId: EMMA.id }, deps);
  if (invoked) return 'runs';
  if (parked || res.status === 'pending_approval') return 'asks';
  if (res.reason === 'shadow') return 'recorded';
  throw new Error(`unexpected gate result for stage ${stage} risk ${risk}: ${JSON.stringify(res)}`);
}

test('the table covers every level and every risk class the gate knows', () => {
  assert.deepEqual(Object.keys(TABLE.stages).sort(), ['0', '1', '2', '3']);
  assert.deepEqual([...TABLE.risks].sort(), ['delete', 'draft', 'execute', 'pay', 'publish', 'read', 'send', 'sign']);
  for (const stage of Object.keys(TABLE.stages)) {
    assert.deepEqual(Object.keys(TABLE.stages[stage]).sort(), [...TABLE.risks].sort(), `stage ${stage} must list every risk class`);
  }
});

test('what the Trust page says each level allows is what the gate does', async () => {
  const actual: Record<string, Record<string, string>> = {};
  for (const stage of [0, 1, 2, 3] as const) {
    actual[stage] = {};
    for (const risk of TABLE.risks) actual[stage][risk] = await outcome(stage, risk);
  }
  assert.deepEqual(actual, TABLE.stages);
});

test('nothing that reaches a customer or moves money ever runs on its own, at any level', async () => {
  for (const stage of [0, 1, 2, 3] as const) {
    for (const risk of ['send', 'publish', 'sign', 'pay', 'delete', 'execute'] as const) {
      assert.notEqual(await outcome(stage, risk), 'runs', `${risk} must not run alone at level ${stage}`);
    }
  }
});
