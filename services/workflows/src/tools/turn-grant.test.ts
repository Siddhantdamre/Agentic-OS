import test from 'node:test';
import assert from 'node:assert';
import { takeHostSessionId } from './turn-grant';

/**
 * `takeHostSessionId` is the only pure part of the grant, and it is the part
 * that has to be right: it reads a value out of a payload that reached us
 * through a model's tool call, uses it as a SQL parameter, and must remove it
 * before the payload continues to a provider.
 *
 * The rest of the grant is I/O and is proven by the live probe in
 * check-duty-allowlist.js, which runs a real self-directed turn and asserts the
 * out-of-grant tool is refused.
 */

test('a namespaced session id is read out', () => {
  const payload: Record<string, unknown> = {
    _host_session_id: 'darex:11111111-2222-3333-4444-555555555555:work-1',
    query: 'select 1',
  };
  assert.strictEqual(
    takeHostSessionId(payload),
    'darex:11111111-2222-3333-4444-555555555555:work-1'
  );
});

test('it is REMOVED from the payload', () => {
  // A tool module has no business seeing it, and a stray field fails a strict
  // provider schema — which would turn a privilege fix into a broken tool call.
  const payload: Record<string, unknown> = { _host_session_id: 'darex:o:k', query: 'x' };
  takeHostSessionId(payload);
  assert.ok(!('_host_session_id' in payload));
  assert.deepEqual(payload, { query: 'x' });
});

test('the model-carrying form is accepted', () => {
  // Patch 0002 appends `:m=<model>` for a budget-degraded turn. The grant is
  // keyed on the whole string, so this must parse or every degraded duty would
  // silently fall back to the org-wide union.
  assert.strictEqual(
    takeHostSessionId({ _host_session_id: 'darex:o:k:m=atomic-agent-deepseek' }),
    'darex:o:k:m=atomic-agent-deepseek'
  );
});

test('a missing field yields null rather than throwing', () => {
  // The overwhelming majority of tool calls are customer turns with no grant.
  assert.strictEqual(takeHostSessionId({ query: 'x' }), null);
  assert.strictEqual(takeHostSessionId({}), null);
  assert.strictEqual(takeHostSessionId(null as unknown as Record<string, unknown>), null);
});

test('anything that is not a plausible session id is rejected', () => {
  // This value reaches a SQL parameter and a log line. It is parameterised, so
  // injection is not the threat — a hostile value being USED as a lookup key
  // is, so the charset is the shape a host-built session id can actually have.
  for (const bad of [
    '',
    '   ',
    42,
    { nested: true },
    ['array'],
    "darex:o:k'; DROP TABLE duty_turn_grants; --",
    'darex:o:k with spaces',
    'darex:o:\n',
    'x'.repeat(201),
  ]) {
    assert.strictEqual(
      takeHostSessionId({ _host_session_id: bad } as Record<string, unknown>),
      null,
      `should reject: ${JSON.stringify(bad).slice(0, 40)}`
    );
  }
});

test('a session id at the length limit still passes', () => {
  const sid = 'darex:' + 'a'.repeat(194);
  assert.strictEqual(sid.length, 200);
  assert.strictEqual(takeHostSessionId({ _host_session_id: sid }), sid);
});
