import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIRST_PARTY_SKILLS,
  filterCatalogByAllowlist,
  readySkillsForOrg,
  toolsFromConnectedSkills,
} from './catalog.js';

test('readySkillsForOrg gates on connected providers only', () => {
  const ready = readySkillsForOrg(['gmail', 'hubspot']);
  const ids = ready.map((s) => s.id);
  assert.ok(ids.includes('gmail-playbook'));
  assert.ok(ids.includes('sales-crm'));
  assert.equal(ids.includes('ecommerce'), false);
  assert.equal(ids.includes('drive-playbook'), false);
});

test('toolsFromConnectedSkills expands only ready skill tools', () => {
  const tools = toolsFromConnectedSkills(['stripe']);
  assert.ok(tools.includes('stripe') || tools.includes('stripe-create-payment-link'));
  assert.equal(tools.some((t) => t.includes('shopify')), false);
});

test('filterCatalogByAllowlist never invents disconnected connectors', () => {
  const catalog = [
    { name: 'gmail_fetch', tool: 'gmail' },
    { name: 'hubspot_contacts', tool: 'hubspot' },
    { name: 'web_search', tool: 'web_search' },
  ];
  const filtered = filterCatalogByAllowlist(catalog, ['gmail'], ['web_search']);
  const names = filtered.map((t) => t.name);
  assert.deepEqual(names.sort(), ['gmail_fetch', 'web_search'].sort());
});

test('empty allowlist exposes only core tools', () => {
  const catalog = [
    { name: 'gmail_fetch', tool: 'gmail' },
    { name: 'web_search', tool: 'web_search' },
  ];
  const filtered = filterCatalogByAllowlist(catalog, undefined, ['web_search']);
  assert.deepEqual(filtered.map((t) => t.name), ['web_search']);
});

test('first-party catalog has stable ids', () => {
  assert.ok(FIRST_PARTY_SKILLS.length >= 10);
  const ids = new Set(FIRST_PARTY_SKILLS.map((s) => s.id));
  assert.equal(ids.size, FIRST_PARTY_SKILLS.length);
});
