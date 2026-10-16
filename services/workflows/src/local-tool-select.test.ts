import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { resolveLocalToolInvocation, selectToolsForLocalTurn } from './local-tool-select.js';
import type { ToolDef } from './tool-definitions.js';

const stubCatalog: ToolDef[] = [
  {
    name: 'web_search',
    tool: 'web_search',
    action: 'search',
    description: 'search',
    schema: {},
  },
  {
    name: 'gmail_fetch',
    tool: 'gmail',
    action: 'fetch',
    description: 'fetch',
    schema: { count: z.number().optional() },
  },
  {
    name: 'hubspot_contacts',
    tool: 'hubspot',
    action: 'list',
    description: 'list',
    schema: {},
  },
  {
    name: 'shopify_fetch_orders',
    tool: 'shopify',
    action: 'fetch',
    description: 'orders',
    schema: {},
  },
];

test('selectToolsForLocalTurn never grants tools outside allowlist even with matching intent', () => {
  const selected = selectToolsForLocalTurn(
    stubCatalog,
    ['gmail'],
    'Sales / growth',
    'check hubspot pipeline and shopify orders'
  );
  const names = selected.map((t) => t.name);
  assert.ok(names.includes('gmail_fetch'));
  assert.equal(names.includes('hubspot_contacts'), false);
  assert.equal(names.includes('shopify_fetch_orders'), false);
});

test('empty allowlist exposes only core tools', () => {
  const selected = selectToolsForLocalTurn(stubCatalog, undefined, 'Sales', 'hubspot deals');
  assert.deepEqual(
    selected.map((t) => t.name),
    ['web_search']
  );
});

test('environment variables cannot widen the local tool allowlist', () => {
  const previous = process.env.DAREX_ALL_TOOLS;
  process.env.DAREX_ALL_TOOLS = 'true';
  try {
    const selected = selectToolsForLocalTurn(stubCatalog, ['gmail'], 'Sales', 'check hubspot');
    const names = selected.map((t) => t.name);
    assert.deepEqual(names, ['web_search', 'gmail_fetch']);
    assert.equal(names.includes('hubspot_contacts'), false);
  } finally {
    if (previous === undefined) delete process.env.DAREX_ALL_TOOLS;
    else process.env.DAREX_ALL_TOOLS = previous;
  }
});

test('a full allowlist keeps every tool, and a message about the tail is not dropped when over the cap', () => {
  const wide: ToolDef[] = [];
  for (let i = 0; i < 170; i += 1) {
    wide.push({
      name: `extra_tool_${i}`,
      tool: `extra-${i}`,
      action: 'read',
      description: 'extra',
      schema: {},
    });
  }
  wide.push({
    name: 'quickbooks_list_invoices',
    tool: 'quickbooks',
    action: 'list',
    description: 'invoices',
    schema: {},
  });
  const allow = wide.map((t) => t.tool);
  const selected = selectToolsForLocalTurn(wide, allow, 'Finance', 'list quickbooks invoices');
  assert.equal(selected.some((t) => t.name === 'quickbooks_list_invoices'), true);
  assert.equal(selected.length <= 160, true);
});

test('file_ops write uses the argument action instead of auto_execute', () => {
  const invoked = resolveLocalToolInvocation(
    { tool: 'file_ops', action: 'auto_execute' },
    { org_id: 'spoof', action: 'write_file', path: 'notes.txt', content: 'hello' },
  );
  assert.equal(invoked.action, 'write_file');
  assert.equal('org_id' in invoked.payload, false);
  assert.equal('action' in invoked.payload, false);
  assert.equal(invoked.payload.content, 'hello');
});
