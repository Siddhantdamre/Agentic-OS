/**
 * Crew planner tests.
 *
 * The planner takes untrusted model output and turns it into agents that hold
 * real tools against a real tenant's data. These tests treat the model as
 * adversarial, because prompt injection makes that literally true: a hostile
 * inbound message can try to steer the planner.
 *
 * Run: node --test dist/crew-planner.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  validateCrewPlan,
  buildCrewPlanPrompt,
  extractPlanJson,
  MIN_CREW_SIZE,
  type CrewCandidate,
} from './crew-planner';
import { MAX_CREW_SPAWN } from './crew-contract';

const roster: CrewCandidate[] = [
  { employeeId: 'e-sales', name: 'Sarah', role: 'sales', persona: 'p1', toolAllowlist: ['gmail', 'hubspot'] },
  { employeeId: 'e-support', name: 'Emma', role: 'support', persona: 'p2', toolAllowlist: ['zendesk'] },
  { employeeId: 'e-ops', name: 'Marcus', role: 'ops', persona: 'p3', toolAllowlist: ['google-sheets'] },
  { employeeId: 'e-finance', name: 'Priya', role: 'finance', persona: 'p4', toolAllowlist: ['quickbooks', 'stripe'] },
];

test('a valid multi-specialist plan is accepted', () => {
  const plan = validateCrewPlan(
    {
      assignments: [
        { employeeId: 'e-sales', subtask: 'Qualify the lead and log it' },
        { employeeId: 'e-finance', subtask: 'Check the invoice status' },
      ],
      reason: 'independent sales and finance parts',
    },
    roster
  );
  assert.strictEqual(plan.mode, 'crew');
  assert.strictEqual(plan.assignments.length, 2);
  assert.strictEqual(plan.assignments[0].name, 'Sarah');
});

test('SECURITY: a hallucinated employee is dropped', () => {
  // The critical guard. An invented specialist would arrive with no persona,
  // no owner, and no defined tool allowlist.
  const plan = validateCrewPlan(
    {
      assignments: [
        { employeeId: 'e-sales', subtask: 'Qualify the lead' },
        { employeeId: 'e-legal-does-not-exist', subtask: 'Review the contract' },
        { employeeId: 'e-finance', subtask: 'Check the invoice' },
      ],
    },
    roster
  );
  assert.strictEqual(plan.assignments.length, 2);
  assert.ok(!plan.assignments.some((a) => a.employeeId.includes('legal')));
  assert.ok(plan.rejected.some((r) => /unknown employee/i.test(r.reason)), 'rejection recorded for audit');
});

test('SECURITY: the model cannot grant itself tools', () => {
  // Permission escalation attempt: the plan claims a sales agent may touch
  // payments. The allowlist must come from the employee record only.
  const plan = validateCrewPlan(
    {
      assignments: [
        { employeeId: 'e-sales', subtask: 'Refund the customer', toolAllowlist: ['stripe', 'quickbooks', 'razorpay'] },
        { employeeId: 'e-support', subtask: 'Reply to the ticket', toolAllowlist: ['*'] },
      ],
    },
    roster
  );
  assert.deepStrictEqual(plan.assignments[0].toolAllowlist, ['gmail', 'hubspot'], 'DB allowlist wins');
  assert.deepStrictEqual(plan.assignments[1].toolAllowlist, ['zendesk']);
  assert.ok(!plan.assignments.some((a) => a.toolAllowlist.includes('stripe')));
  assert.ok(!plan.assignments.some((a) => a.toolAllowlist.includes('*')));
});

test('SECURITY: mutating a returned allowlist cannot affect the roster', () => {
  const plan = validateCrewPlan(
    {
      assignments: [
        { employeeId: 'e-sales', subtask: 'a' },
        { employeeId: 'e-support', subtask: 'b' },
      ],
    },
    roster
  );
  plan.assignments[0].toolAllowlist.push('stripe');
  assert.deepStrictEqual(roster[0].toolAllowlist, ['gmail', 'hubspot'], 'roster must not be aliased');
});

test('SECURITY: crew size is capped at MAX_CREW_SPAWN', () => {
  const plan = validateCrewPlan(
    {
      assignments: roster.map((c, i) => ({ employeeId: c.employeeId, subtask: `task ${i}` })),
    },
    roster
  );
  assert.strictEqual(plan.assignments.length, MAX_CREW_SPAWN);
  assert.ok(plan.rejected.some((r) => /MAX_CREW_SPAWN/.test(r.reason)));
});

test('duplicate assignments to one employee are rejected', () => {
  const plan = validateCrewPlan(
    {
      assignments: [
        { employeeId: 'e-sales', subtask: 'Qualify the lead' },
        { employeeId: 'e-sales', subtask: 'Also qualify the lead' },
        { employeeId: 'e-support', subtask: 'Answer the ticket' },
      ],
    },
    roster
  );
  assert.strictEqual(plan.assignments.length, 2);
  assert.ok(plan.rejected.some((r) => /duplicate/i.test(r.reason)));
});

test('a single valid specialist falls back to solo', () => {
  // A crew of one still pays for a synthesis turn — strictly worse than one agent.
  const plan = validateCrewPlan(
    { assignments: [{ employeeId: 'e-sales', subtask: 'Handle it' }] },
    roster
  );
  assert.strictEqual(plan.mode, 'solo');
  assert.match(plan.reason, new RegExp(`needs ${MIN_CREW_SIZE}`));
});

test('SAFETY: malformed model output degrades to solo, never throws', () => {
  const garbage: any[] = [
    null,
    undefined,
    {},
    { assignments: null },
    { assignments: [] },
    { assignments: 'not an array' },
    { assignments: [{}] },
    { assignments: [{ employeeId: 123, subtask: {} }] },
    { assignments: [{ employeeId: '', subtask: '' }] },
    { assignments: [{ subtask: 'no id' }] },
  ];
  for (const raw of garbage) {
    const plan = validateCrewPlan(raw, roster);
    assert.strictEqual(plan.mode, 'solo', `expected solo for ${JSON.stringify(raw)}`);
    assert.strictEqual(plan.assignments.length, 0);
  }
});

test('an empty roster can never produce a crew', () => {
  const plan = validateCrewPlan(
    { assignments: [{ employeeId: 'e-sales', subtask: 'x' }, { employeeId: 'e-support', subtask: 'y' }] },
    []
  );
  assert.strictEqual(plan.mode, 'solo');
});

test('overlong subtasks are truncated, not rejected', () => {
  const plan = validateCrewPlan(
    {
      assignments: [
        { employeeId: 'e-sales', subtask: 'x'.repeat(5000) },
        { employeeId: 'e-support', subtask: 'y' },
      ],
    },
    roster
  );
  assert.strictEqual(plan.mode, 'crew');
  assert.ok(plan.assignments[0].subtask.length <= 400);
});

test('the prompt presents a closed roster and forbids invention', () => {
  const prompt = buildCrewPlanPrompt('Chase the invoice and book a viewing', roster);
  assert.match(prompt, /e-sales/);
  assert.match(prompt, /Never invent an employee/i);
  assert.match(prompt, /Prefer ONE employee/i, 'crews must be the exception');
  assert.match(prompt, new RegExp(`at most ${MAX_CREW_SPAWN}`));
});

test('the prompt does not leak persona text', () => {
  // Personas can contain org-specific instructions; the planner only needs
  // identity, role and tools to choose.
  const prompt = buildCrewPlanPrompt('do a thing', roster);
  assert.ok(!prompt.includes('p1'), 'persona should not be in the planning prompt');
});

test('plan JSON survives fences and surrounding prose', () => {
  const wrapped = 'Sure!\n```json\n{"assignments":[{"employeeId":"e-sales","subtask":"go"}],"reason":"r"}\n```\nHope that helps';
  const parsed = extractPlanJson(wrapped);
  assert.ok(parsed);
  assert.strictEqual(parsed!.assignments![0].employeeId, 'e-sales');
});

test('unparseable model output returns null rather than throwing', () => {
  for (const bad of ['', 'no json here', '{ broken', '```json\nnot json\n```']) {
    assert.strictEqual(extractPlanJson(bad), null);
  }
});

test('AUDIT: every rejection is recorded with a reason', () => {
  const plan = validateCrewPlan(
    {
      assignments: [
        { employeeId: 'ghost', subtask: 'x' },
        { employeeId: 'e-sales', subtask: '' },
        { employeeId: 'e-support', subtask: 'ok' },
        { employeeId: 'e-ops', subtask: 'ok2' },
      ],
    },
    roster
  );
  assert.strictEqual(plan.assignments.length, 2);
  assert.strictEqual(plan.rejected.length, 2);
  for (const r of plan.rejected) {
    assert.ok(r.reason.length > 0, 'each rejection must explain itself');
  }
});
