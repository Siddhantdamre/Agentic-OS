import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logDecision } from './operations/decision-ledger.js';
import { evaluateEmployeeMetric, recordEmployeeMetrics } from './employee-metrics.js';

test('obligation extract rate of zero alerts', () => {
  const ev = evaluateEmployeeMetric('org-1', 'obligations_per_100_messages', 0);
  assert.equal(ev.kind, 'zero');
});

test('approval rate above 90 percent alerts as fatigue', () => {
  const ev = evaluateEmployeeMetric('org-1', 'approval_rate', 0.97);
  assert.equal(ev.kind, 'above');
});

test('recordEmployeeMetrics returns structured fields for decision logging', () => {
  const fields = recordEmployeeMetrics({
    orgId: 'org-test',
    employeeRole: 'customer',
    actionType: 'gmail.send_email',
    decision: 'executed',
    reasonCode: 'allowed',
  });
  assert.equal(fields.org_id, 'org-test');
  assert.equal(fields.employee_role, 'customer');
  assert.equal(fields.action_type, 'gmail.send_email');
  assert.equal(fields.decision, 'executed');
  assert.equal(fields.reason_code, 'allowed');
  assert.equal(fields.confidence, 1.0);
});

function fakeClient() {
  const calls: unknown[][] = [];
  const client = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return { rows: [{ id: 'l1', org_id: 'o', employee_role: 'r', action_considered: 'a', decision: 'executed', reason_code: 'x', reason_summary: 's', confidence_score: '0.5', created_at: new Date().toISOString() }] };
    },
  };
  return { client: client as never, calls };
}

const base = { orgId: 'o', employeeRole: 'ops', actionConsidered: 'a', decision: 'executed' as const, reasonCode: 'x', reasonSummary: 's', confidence: 0.5 };

test('ledger: logDecision writes employee_id when a valid uuid is given', async () => {
  const { client, calls } = fakeClient();
  await logDecision(client, { ...base, employeeId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(calls[0][12], '11111111-1111-4111-8111-111111111111');
});

test('ledger: logDecision writes null employee_id when absent or malformed', async () => {
  const { client, calls } = fakeClient();
  await logDecision(client, base);
  await logDecision(client, { ...base, employeeId: 'not-a-uuid' });
  assert.equal(calls[0][12], null);
  assert.equal(calls[1][12], null);
});
