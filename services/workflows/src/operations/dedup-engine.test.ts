import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickDedup, trigramSimilarity } from './dedup-engine.js';

test('Acme Tech Solutions merges with Acme Technologies on name+domain', () => {
  const result = pickDedup(
    { name: 'Acme Tech Solutions', domain: 'acme.com', phone: '+1 415 555 0100' },
    [{ id: '1', name: 'Acme Technologies', domain: 'acme.com', phone: '14155550100' }]
  );
  assert.ok(result.total >= 0.85, `expected merge score, got ${result.total}`);
  assert.equal(result.decision, 'merge');
});

test('Apex Transportation Inc vs Apex Trans quarantines', () => {
  const result = pickDedup(
    { name: 'Apex Transportation Inc', domain: 'apex-transport.com', phone: '4155550199' },
    [{ id: '2', name: 'Apex Transportation', domain: 'apextrans.io', phone: '4155550199' }]
  );
  assert.ok(result.total >= 0.6 && result.total < 0.85, `expected quarantine band, got ${result.total}`);
  assert.equal(result.decision, 'quarantine');
});

test('unrelated names create a new record', () => {
  const result = pickDedup(
    { name: 'Nexus Analytics', domain: 'nexus.io' },
    [{ id: '3', name: 'Pinecone Freight', domain: 'pinecone.example' }]
  );
  assert.ok(result.total < 0.6, `expected create, got ${result.total}`);
  assert.equal(result.decision, 'create');
  assert.ok(trigramSimilarity('Nexus Analytics', 'Pinecone Freight') < 0.4);
});
