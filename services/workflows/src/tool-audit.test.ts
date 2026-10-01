import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argsHash, buildToolInvocationRow, canonicalJson } from './tool-audit.js';

const ORG = '00000000-0000-0000-0000-0000000000b2';

test('args hash ignores key order and never stores raw args', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(argsHash({ to: 'x@y.com', subject: 'hi' }), argsHash({ subject: 'hi', to: 'x@y.com' }));
  assert.notEqual(argsHash({ amount: 1 }), argsHash({ amount: 2 }));
  assert.match(argsHash(undefined), /^[0-9a-f]{64}$/);
});

test('row carries status, risk, latency and the error message', () => {
  const row = buildToolInvocationRow({
    params: { tool: 'Gmail', action: 'SEND_EMAIL', payload: { to: 'a@b.c' }, orgId: ORG },
    employeeRole: 'customer',
    result: { tool: 'gmail', action: 'send_email', status: 'error', message: 'revoked', data: null, timestamp: '' },
    latencyMs: 12.6,
  });
  assert.equal(row.tool, 'gmail');
  assert.equal(row.action, 'send_email');
  assert.equal(row.status, 'error');
  assert.equal(row.error, 'revoked');
  assert.equal(row.latencyMs, 13);
  assert.equal(row.employeeRole, 'customer');
  assert.equal(row.risk, 'send');
  assert.equal(JSON.stringify(row).includes('a@b.c'), false);
});

test('thrown calls are audited as thrown; unknown tools have no risk', () => {
  const row = buildToolInvocationRow({
    params: { tool: 'no_such_tool', action: '', payload: {}, orgId: ORG },
    thrown: new Error('boom'),
    latencyMs: -3,
  });
  assert.equal(row.status, 'thrown');
  assert.equal(row.error, 'boom');
  assert.equal(row.risk, null);
  assert.equal(row.action, 'auto_execute');
  assert.equal(row.latencyMs, 0);
});
