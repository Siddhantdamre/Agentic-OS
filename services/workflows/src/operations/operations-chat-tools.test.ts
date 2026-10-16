import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUnifiedSystemPrompt } from '../prompts/system-prompt-builder.js';
import { TOOLS } from '../tool-definitions.js';
import { ALWAYS_ALLOWED_CORE_TOOLS } from '../tool-executor.js';
import { getToolModule } from '../tools/index.js';

function mergeOpsAllowlist(seed: string[]): string[] {
  const union = new Set(seed.map((t) => t.toLowerCase()));
  for (const t of ALWAYS_ALLOWED_CORE_TOOLS) union.add(String(t).toLowerCase());
  // Roster backfill for Operations chat tools + showings (migration 111 / provision).
  union.add('operations');
  union.add('re');
  return [...union].sort();
}

test('Operations allowlist merge keeps seed tools and adds operations + re', () => {
  const merged = mergeOpsAllowlist([
    'hubspot',
    'database_query',
    'google-calendar',
    'google-sheets',
    'slack',
    'gmail',
  ]);
  assert.ok(merged.includes('operations'));
  assert.ok(merged.includes('re'));
  assert.ok(merged.includes('hubspot'));
  assert.ok(merged.includes('google-sheets'));
  assert.ok(merged.includes('web_search'));
});

test('Operations MCP tool defs cover reconcile, dedup, deadlocks, work items, rent', () => {
  const names = new Set(TOOLS.map((t) => t.name));
  for (const required of [
    'calendar_update_event',
    'ops_reconcile_audit',
    'ops_dedup_contacts',
    'ops_calendar_deadlocks',
    'ops_meeting_prep',
    'work_item_create',
    'work_item_reassign',
    'work_item_set_priority',
    'ops_list_discrepancies',
    'rent_reminders_list',
  ]) {
    assert.ok(names.has(required), `missing tool ${required}`);
  }
  assert.equal(TOOLS.find((t) => t.name === 'calendar_update_event')?.tool, 'google-calendar');
  assert.equal(TOOLS.find((t) => t.name === 'ops_reconcile_audit')?.tool, 'operations');
  assert.ok(getToolModule('operations'));
  assert.ok(getToolModule('operations')?.actions.includes('reconcile_audit'));
});

test('Operations system prompt lists preferred tools and hand-offs', () => {
  const prompt = buildUnifiedSystemPrompt({
    orgId: '00000000-0000-0000-0000-000000000001',
    employeeName: 'Operations',
    employeeRole: 'Operations',
    employeePersona: 'triage',
  });
  assert.match(prompt, /ops_reconcile_audit/);
  assert.match(prompt, /refunds\/returns → Customer/);
  assert.match(prompt, /payment links\/invoices\/charges → Finance/);

  const other = buildUnifiedSystemPrompt({
    orgId: '00000000-0000-0000-0000-000000000001',
    employeeName: 'Growth',
    employeeRole: 'Growth',
  });
  assert.doesNotMatch(other, /Operations preferred tools/);
});
