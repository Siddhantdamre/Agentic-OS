import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zoho } from './zoho.js';
import { leegality } from './leegality.js';
import { quickbooks } from './quickbooks.js';

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
  assert.equal(result.data?.contacts, undefined);
  assert.equal(result.data?.documents, undefined);
  assert.equal(result.data?.customers, undefined);
  assert.ok(result.data?.connected === false, `${tool} must not fabricate a connected payload`);
}

test('zoho never-configured is honest notConnected', async () => {
  const result = await zoho.execute(ctx('zoho-crm', 'list_contacts'));
  assertHonestDisconnect(result, 'zoho-crm');
});

test('leegality never-configured is honest notConnected', async () => {
  const prev = process.env.LEEGALITY_API_TOKEN;
  delete process.env.LEEGALITY_API_TOKEN;
  try {
    const result = await leegality.execute(ctx('leegality', 'list_documents'));
    assertHonestDisconnect(result, 'leegality');
  } finally {
    if (prev !== undefined) process.env.LEEGALITY_API_TOKEN = prev;
  }
});

test('quickbooks never-configured is honest notConnected', async () => {
  const result = await quickbooks.execute(ctx('quickbooks', 'list_customers'));
  assertHonestDisconnect(result, 'quickbooks');
});
