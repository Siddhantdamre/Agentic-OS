import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorFromEmployeeRow, resolvePlanStepActor } from './plan-step-actor.js';

test('actorFromEmployeeRow returns active employee with persona-filtered allowlist', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    role: 'Marketing & Analytics',
    tool_allowlist: ['google-analytics', 'meta-ads', 'stripe', 'web_search'],
    status: 'active',
  };

  const actor = actorFromEmployeeRow(row);
  assert.equal(actor.ok, true);
  if (!actor.ok) return;

  assert.equal(actor.employeeId, row.id);
  assert.equal(actor.employeeRole, 'Marketing & Analytics');
  // Marketing persona must strip financial tools (stripe) even if listed in row.tool_allowlist
  assert.ok(actor.toolAllowlist.includes('google-analytics'));
  assert.ok(actor.toolAllowlist.includes('meta-ads'));
  assert.ok(!actor.toolAllowlist.includes('stripe'));
});

test('actorFromEmployeeRow rejects inactive employee as employee_unavailable', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000002',
    role: 'Executive',
    tool_allowlist: ['gmail', 'google-calendar'],
    status: 'disabled',
  };

  const actor = actorFromEmployeeRow(row);
  assert.equal(actor.ok, false);
  if (actor.ok) return;
  assert.equal(actor.reason, 'employee_unavailable');
});

test('actorFromEmployeeRow filters Customer Support allowlist to deny prospecting tools', () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000003',
    role: 'Customer Support',
    tool_allowlist: ['zendesk', 'hubspot', 'apollo', 'linkedin', 'gmail'],
    status: 'active',
  };

  const actor = actorFromEmployeeRow(row);
  assert.equal(actor.ok, true);
  if (!actor.ok) return;

  assert.ok(actor.toolAllowlist.includes('zendesk'));
  assert.ok(actor.toolAllowlist.includes('gmail'));
  // Customer Support cannot prospect via Apollo or LinkedIn
  assert.ok(!actor.toolAllowlist.includes('apollo'));
  assert.ok(!actor.toolAllowlist.includes('linkedin'));
});

test('resolvePlanStepActor returns missing_employee when neither id nor role is provided', async () => {
  const actor = await resolvePlanStepActor(
    '00000000-0000-4000-8000-000000000000',
    { employeeId: undefined, employeeRole: undefined },
    undefined,
    undefined,
  );

  assert.equal(actor.ok, false);
  if (actor.ok) return;
  assert.equal(actor.reason, 'missing_employee');
});
