import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apollo } from './apollo.js';
import { linkedin } from './linkedin.js';

const ORG = '00000000-0000-4000-8000-0000000000c6';
const TS = '2026-08-14T00:00:00.000Z';

function ctx(tool: string, action: string) {
  return {
    tool,
    action,
    actionName: action,
    payload: {},
    orgId: ORG,
    timestamp: TS,
  };
}

function assertHonestDisconnect(result: { status: string; data?: any; message?: string }, tool: string) {
  assert.equal(result.status, 'error');
  assert.equal(result.data?.connected, false);
  assert.equal(result.data?.setupUrl, '/connectors');
  assert.match(String(result.message || ''), /not connected/i);
  assert.doesNotMatch(JSON.stringify(result), /fake-|INV-FAKE|ADA@EXAMPLE/i);
  assert.equal(result.data?.people, undefined);
  assert.equal(result.data?.elements, undefined);
  assert.ok(result.data?.connected === false, `${tool} must not fabricate a connected payload`);
}

test('linkedin never-configured is honest notConnected', async () => {
  const result = await linkedin.execute(ctx('linkedin', 'search_people'));
  assertHonestDisconnect(result, 'linkedin');
});

test('apollo never-configured is honest notConnected', async () => {
  const result = await apollo.execute(ctx('apollo', 'search_people'));
  assertHonestDisconnect(result, 'apollo');
});
