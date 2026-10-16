import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyMemoryResult, toRetrieveActivityResult } from './retrieve.js';

test('merge puts SQL citations before graph snippets and drops duplicate text', () => {
  const { mergeMemoryCitations } = require('./retrieve.js');
  const sql = [
    {
      id: 'M-1',
      tier: 'org',
      snippet: 'Refunds are 100 percent within 7 days',
      source: 'human',
      stale: false,
      updatedAt: '2026-09-01',
    },
  ];
  const graph = [
    {
      id: 'G-1',
      tier: 'org',
      snippet: 'Refunds are 100 percent within 7 days',
      source: 'graph',
      stale: false,
      updatedAt: '',
    },
    {
      id: 'G-2',
      tier: 'org',
      snippet: 'Acme prefers email over phone',
      source: 'graph',
      stale: false,
      updatedAt: '',
    },
  ];
  const merged = mergeMemoryCitations(sql, graph);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'M-1');
  assert.equal(merged[1].id, 'G-2');
  assert.equal(merged[1].snippet, 'Acme prefers email over phone');
});

test('empty retrieve maps to empty facts — never invented', () => {
  const mapped = toRetrieveActivityResult(emptyMemoryResult('11111111-1111-4111-8111-111111111111'));
  assert.equal(mapped.noOp, false);
  assert.equal(mapped.emptyIndex, true);
  assert.deepEqual(mapped.facts, []);
  assert.deepEqual(mapped.citations, []);
  assert.equal(mapped.facts.some((f) => /kapoor|listing|3bhk/i.test(f)), false);
});

test('citations become facts and ids without extra prose', () => {
  const mapped = toRetrieveActivityResult({
    orgId: '11111111-1111-4111-8111-111111111111',
    emptyIndex: false,
    citations: [
      {
        id: 'M-17',
        tier: 'entity',
        snippet: 'Priya last asked about 3BHK Andheri West',
        source: 'whatsapp',
        sourceRef: 'conv-1',
        stale: false,
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  });
  assert.equal(mapped.noOp, false);
  assert.equal(mapped.emptyIndex, false);
  assert.deepEqual(mapped.citations, ['M-17']);
  assert.deepEqual(mapped.facts, ['Priya last asked about 3BHK Andheri West']);
});

test('operations persona filters out conversation citations', () => {
  const { filterCitationsForPersona } = require('./retrieve.js');
  const citations = [
    { id: 'M-1', tier: 'org', snippet: 'SOP doc', source: 'human', stale: false, updatedAt: '2026-08-01' },
    { id: 'M-2', tier: 'conversation', snippet: 'Hi there', source: 'whatsapp', stale: false, updatedAt: '2026-08-01' },
    { id: 'M-3', tier: 'entity', snippet: 'Acme record', source: 'crm', stale: false, updatedAt: '2026-08-01' },
  ];
  const filtered = filterCitationsForPersona('operations', citations);
  assert.equal(filtered.length, 2);
  assert.ok(!filtered.some((c: any) => c.tier === 'conversation'));
  assert.ok(filtered.some((c: any) => c.tier === 'org'));
});

test('growth persona filters out conversation citations', () => {
  const { filterCitationsForPersona } = require('./retrieve.js');
  const citations = [
    { id: 'M-1', tier: 'org', snippet: 'Pitch deck', source: 'human', stale: false, updatedAt: '2026-08-01' },
    { id: 'M-2', tier: 'conversation', snippet: 'Chat log', source: 'whatsapp', stale: false, updatedAt: '2026-08-01' },
  ];
  const filtered = filterCitationsForPersona('growth', citations);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].tier, 'org');
});

test('customer persona excludes entity memory of other customers', () => {
  const { filterCitationsForPersona } = require('./retrieve.js');
  const citations = [
    { id: 'M-1', tier: 'entity', sourceRef: 'cust-1', snippet: 'Cust 1 info', source: 'crm', stale: false, updatedAt: '2026-08-01' },
    { id: 'M-2', tier: 'entity', sourceRef: 'cust-2', snippet: 'Cust 2 info', source: 'crm', stale: false, updatedAt: '2026-08-01' },
    { id: 'M-3', tier: 'conversation', snippet: 'This chat', source: 'whatsapp', stale: false, updatedAt: '2026-08-01' },
  ];
  const filtered = filterCitationsForPersona('customer', citations, { entityId: 'cust-1' });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some((c: any) => c.sourceRef === 'cust-1'));
  assert.ok(!filtered.some((c: any) => c.sourceRef === 'cust-2'));
});

test('cognee circuit breaker trips and resets cleanly', () => {
  const { isCogneeCircuitOpen, tripCogneeCircuit, closeCogneeCircuit } = require('./retrieve.js');
  closeCogneeCircuit();
  assert.equal(isCogneeCircuitOpen(), false);

  tripCogneeCircuit();
  assert.equal(isCogneeCircuitOpen(), true);

  closeCogneeCircuit();
  assert.equal(isCogneeCircuitOpen(), false);
});

test('graph citations are their own tier and follow persona exclusions', () => {
  const { filterCitationsForPersona } = require('./retrieve.js');
  const citations = [
    { id: 'M-1', tier: 'org', snippet: 'SOP doc', source: 'human', stale: false, updatedAt: '2026-08-01' },
    { id: 'G-1', tier: 'graph', snippet: 'Other customer said X', source: 'graph', stale: false, updatedAt: '' },
  ];
  for (const persona of ['customer', 'operations', 'growth', 'marketing']) {
    const filtered = filterCitationsForPersona(persona, citations);
    assert.ok(!filtered.some((c: any) => c.tier === 'graph'), `${persona} must not see graph snippets`);
    assert.ok(filtered.some((c: any) => c.id === 'M-1'));
  }
  assert.equal(filterCitationsForPersona('finance', citations).length, 2);
  assert.equal(filterCitationsForPersona('sales', citations).length, 2);
});

test('customer persona limits conversation memory to the current thread in SQL', () => {
  const { conversationThreadOnly } = require('./retrieve.js');
  assert.equal(conversationThreadOnly('Customer Support'), true);
  assert.equal(conversationThreadOnly('customer'), true);
  assert.equal(conversationThreadOnly('Sales'), false);
  assert.equal(conversationThreadOnly(undefined), false);
});

