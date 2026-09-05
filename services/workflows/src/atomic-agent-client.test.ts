import test from 'node:test';
import assert from 'node:assert';
import { sessionModelSuffix,
  buildBusinessIdentity,
} from './atomic-agent-client';

/**
 * THE BUDGET CAP MUST BIND THE BIGGEST CALL THE AGENT MAKES.
 *
 * The vendored agent's model is a deployment setting, so the `model` field sent
 * in the request body was echoed back in the response and ignored upstream.
 * Measured: a workspace over its cap — correctly detected, correctly degraded,
 * correctly recorded as degraded — still spent ~48,000 PAID tokens on its agent
 * turn, because the container used its own configured model.
 *
 * The override now rides the session id, read by
 * `patches/0002-per-request-model.patch`. These tests pin the two halves that
 * have to agree: the charset, and the "normal turns are unchanged" guarantee.
 */

test('a normal turn appends nothing at all', () => {
  // Byte-identical session ids for every un-degraded workspace. If this breaks,
  // every existing agent session is silently orphaned.
  assert.strictEqual(sessionModelSuffix(undefined), '');
  assert.strictEqual(sessionModelSuffix(''), '');
  assert.strictEqual(sessionModelSuffix('   '), '');
});

test('a degraded turn carries the model the budget chose', () => {
  assert.strictEqual(sessionModelSuffix('atomic-agent-deepseek'), ':m=atomic-agent-deepseek');
  assert.strictEqual(sessionModelSuffix('atomic-agent-fallback'), ':m=atomic-agent-fallback');
  // Vendor-prefixed aliases contain a slash and a dot; both are in the charset.
  assert.strictEqual(sessionModelSuffix('openrouter/nvidia/x-1.5'), ':m=openrouter/nvidia/x-1.5');
});

test('a value the patch would reject is never appended', () => {
  // The patch validates the alias and falls back to the deployment default on
  // anything it does not like. Appending such a value would change the session
  // id — orphaning the agent's state — and still not change the model. Worst of
  // both, so the two sides share one charset.
  for (const bad of [
    'model with spaces',
    'alias:with:colons',
    'has=equals',
    'quote"inside',
    'semi;colon',
    'brace{}',
    'x'.repeat(65),
  ]) {
    assert.strictEqual(sessionModelSuffix(bad), '', `must not append: ${bad}`);
  }
});

test('the tenant patch can still read the tenant with the suffix present', () => {
  // Patch 0001 reads parts[1] of `<host>:<tenant>:<rest>` and requires at least
  // three segments. The suffix adds a fourth, so the tenant is still parts[1] —
  // asserted here because breaking it would silently stop per-customer spend
  // attribution, which is invisible until a bill needs explaining.
  const sessionId = `darex:11111111-2222-3333-4444-555555555555:work-1${sessionModelSuffix('atomic-agent-deepseek')}`;
  const parts = sessionId.split(':');
  assert.ok(parts.length >= 3);
  assert.strictEqual(parts[1], '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(parts[parts.length - 1], 'm=atomic-agent-deepseek');
});

test('the agent is told which business it works for, not a UUID', () => {
  const lines = buildBusinessIdentity({
    orgId: '00dc55bd-4063-47e2-8aa1-5350202f6863',
    employeeName: 'Kabir',
    employeeRole: 'Showing coordinator',
    employeePersona: 'x',
    businessName: 'Bright Leaf Interiors',
    businessType: 'furniture retail',
    toolAllowlist: [],
    userMessage: 'hi',
  } as never).join(' ');
  assert.match(lines, /Bright Leaf Interiors/);
  assert.match(lines, /furniture retail/);
  // The UUID must never be presented as the employer.
  assert.ok(!lines.includes('00dc55bd'), lines);
  // Speak AS the business, and never ask the customer for its own details -
  // the multi-turn suite caught the agent asking a customer for the showroom
  // address, because it did not know where it worked.
  assert.match(lines, /Speak as Bright Leaf Interiors/);
  assert.match(lines, /Never ask a customer for this business/i);
});

test('an unnamed workspace gets no invented identity', () => {
  const lines = buildBusinessIdentity({
    orgId: '00dc55bd-4063-47e2-8aa1-5350202f6863',
    employeeName: 'Kabir',
    employeeRole: 'r',
    employeePersona: 'p',
    toolAllowlist: [],
    userMessage: 'hi',
  } as never).join(' ');
  assert.match(lines, /on behalf of this business/);
  assert.ok(!lines.includes('00dc55bd'), lines);
  assert.ok(!/undefined|null/.test(lines), lines);
});

test('a named business with no type states the name and skips the type', () => {
  const lines = buildBusinessIdentity({
    orgId: 'o', employeeName: 'Sarah', employeeRole: 'r', employeePersona: 'p',
    businessName: 'Sharma Properties', toolAllowlist: [], userMessage: 'hi',
  } as never).join(' ');
  assert.match(lines, /Sharma Properties/);
  assert.ok(!/ a  business|a undefined/.test(lines), lines);
});
