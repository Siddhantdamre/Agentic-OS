import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runEmployeeLoop } from './employee-loop.js';

const frame = {
  what: 'send the revised quote',
  who: 'acme',
  resolved: async () => false,
};

test('already resolved exits at assess with zero model calls', async () => {
  let planned = 0;
  const result = await runEmployeeLoop({
    frame: { ...frame, resolved: async () => true },
    planner: async () => {
      planned += 1;
      return { steps: [] };
    },
    gate: async () => ({ mode: 'execute', reasonCode: 'reversible_within_policy' }),
    execute: async () => ({ ok: true }),
    verify: async () => true,
  });
  assert.equal(result.outcome, 'already_resolved');
  assert.equal(result.reasonCode, 'already_resolved');
  assert.equal(result.modelCalls, 0);
  assert.equal(planned, 0);
});

test('explicit assess callback exits at step 3 with zero model calls', async () => {
  let planned = 0;
  const result = await runEmployeeLoop({
    frame: { ...frame, resolved: async () => false },
    assess: async () => ({ resolved: true, reason: 'order_already_shipped' }),
    planner: async () => {
      planned += 1;
      return { steps: [] };
    },
    gate: async () => ({ mode: 'execute', reasonCode: 'reversible_within_policy' }),
    execute: async () => ({ ok: true }),
    verify: async () => true,
  });
  assert.equal(result.outcome, 'already_resolved');
  assert.equal(result.reasonCode, 'order_already_shipped');
  assert.equal(result.modelCalls, 0);
  assert.equal(planned, 0);
});

test('verification fails escalates and does not close', async () => {
  const result = await runEmployeeLoop({
    frame,
    planner: async () => ({
      steps: [{ tool: 'gmail', action: 'send', args: {}, why: 'x', expect: 'sent' }],
    }),
    gate: async () => ({ mode: 'execute', reasonCode: 'reversible_within_policy' }),
    execute: async () => ({ ok: true }),
    verify: async () => false,
  });
  assert.equal(result.outcome, 'escalated');
  assert.equal(result.reasonCode, 'verification_failed');
  assert.equal(result.completed.length, 0);
});

test('visible partial failure freezes and does not compensate', async () => {
  const executed: string[] = [];
  const result = await runEmployeeLoop({
    frame,
    planner: async () => ({
      steps: [
        { tool: 'gmail', action: 'send', args: {}, why: 'apology', expect: 'sent', visible: true },
        { tool: 'stripe', action: 'credit', args: {}, why: 'refund', expect: 'credited' },
      ],
    }),
    gate: async () => ({ mode: 'execute', reasonCode: 'reversible_within_policy' }),
    execute: async (step) => {
      executed.push(step.action);
      if (step.action === 'credit') return { ok: false };
      return { ok: true, visible: true };
    },
    verify: async () => true,
  });
  assert.equal(result.outcome, 'frozen');
  assert.equal(result.reasonCode, 'partial_failure_frozen');
  assert.deepEqual(executed, ['send', 'credit']);
  assert.equal(result.completed.length, 1);
});

test('budget exhausted on a six-step plan aborts with a ledger row', async () => {
  const ledger: string[] = [];
  const result = await runEmployeeLoop({
    frame,
    planner: async () => ({
      steps: Array.from({ length: 6 }, (_, i) => ({
        tool: 'crm',
        action: `step_${i}`,
        args: {},
        why: 'x',
        expect: 'ok',
      })),
    }),
    gate: async () => ({ mode: 'execute', reasonCode: 'reversible_within_policy' }),
    execute: async () => ({ ok: true }),
    verify: async () => true,
    ledger: (row) => {
      ledger.push(row.reasonCode);
    },
  });
  assert.equal(result.outcome, 'budget_exhausted');
  assert.equal(result.reasonCode, 'budget_exhausted');
  assert.deepEqual(ledger, ['budget_exhausted']);
});
