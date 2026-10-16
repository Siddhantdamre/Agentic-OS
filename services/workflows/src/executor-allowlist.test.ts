import assert from 'node:assert/strict';
import test from 'node:test';
import { ALWAYS_ALLOWED_CORE_TOOLS, isToolAllowed } from './tool-executor.js';

test('core tools do not include host code execution', () => {
  const core = ALWAYS_ALLOWED_CORE_TOOLS.map((t) => t.toLowerCase());
  for (const banned of ['terminal_run_command', 'bash_execute', 'python_execute', 'file_ops', 'sandbox', 'cognee_remember']) {
    assert.equal(core.includes(banned), false, banned);
  }
  assert.ok(core.includes('web_search'));
  assert.ok(core.includes('database_query'));
});

test('allowlist prefix does not grant an unregistered tool id', () => {
  assert.equal(isToolAllowed('stripe_create_charge_extra', ['stripe']), false);
  assert.equal(isToolAllowed('stripe', ['stripe']), true);
});

test('plan step runs as its stamped employee card, never the plan tool list', async () => {
  const { actorFromEmployeeRow, resolvePlanStepActor } = await import('./plan-step-actor.js');
  const actor = actorFromEmployeeRow({
    id: '00000000-0000-4000-8000-000000000002',
    role: 'Research',
    tool_allowlist: ['notion'],
    status: 'active',
  });
  assert.equal(actor.ok, true);
  if (actor.ok === true) {
    assert.equal(actor.employeeRole, 'Research');
    assert.equal(isToolAllowed('notion', actor.toolAllowlist), true);
    assert.equal(isToolAllowed('stripe', actor.toolAllowlist), false);
  }
  const paused = actorFromEmployeeRow({ id: 'x', role: 'Research', tool_allowlist: [], status: 'paused' });
  assert.equal(paused.ok, false);
  assert.equal(actorFromEmployeeRow(undefined).ok, false);
  const unstamped = await resolvePlanStepActor('00000000-0000-4000-8000-000000000001', {});
  assert.equal(unstamped.ok, false);
  if (unstamped.ok === false) assert.equal(unstamped.reason, 'missing_employee');
});
